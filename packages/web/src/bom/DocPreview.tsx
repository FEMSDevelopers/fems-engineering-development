import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PartDoc } from "@fpl/core";
import { api } from "../api";
import { ZoomControls } from "../viewer/PdfViewer";
import { openPdfViewer } from "../viewer/pdfStore";

const OPEN_DELAY = 350;
const CLOSE_GRACE = 160;
const PAGE_H = 420;
const SIZE_KEY = "fpl.docprev.size";
const HEAD_H = 34;

// Shift held anywhere in the window (keeps the preview open and makes it resizable).
let shiftDown = false;
const shiftSubs = new Set<() => void>();
const setShift = (v: boolean) => {
  if (v === shiftDown) return;
  shiftDown = v;
  shiftSubs.forEach((f) => f());
};
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => e.key === "Shift" && setShift(true), true);
  window.addEventListener("keyup", (e) => e.key === "Shift" && setShift(false), true);
  window.addEventListener("blur", () => setShift(false));
}
const useShift = () => useSyncExternalStore((f) => (shiftSubs.add(f), () => shiftSubs.delete(f)), () => shiftDown);

/** Preview size chosen by resizing (this browser), or null for the default. */
function loadSize(): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    return v && v.w > 0 && v.h > 0 ? v : null;
  } catch {
    return null;
  }
}
function saveSize(v: { w: number; h: number } | null) {
  try {
    if (v) localStorage.setItem(SIZE_KEY, JSON.stringify(v));
    else localStorage.removeItem(SIZE_KEY);
  } catch {
    /* storage blocked: size lasts for this page */
  }
}

/**
 * Hover preview of a stored document: the first two pages side by side (PDF via pdf.js, or the image
 * itself). Everything is released as soon as the preview closes — mouse leaves both the link and
 * the popup, a click outside it, or Esc: the download is aborted, rendering cancelled, the PDF
 * document destroyed and the canvases emptied.
 * Holding Shift keeps it open when the mouse leaves and makes it resizable (drag the bottom-right corner); the size is
 * remembered in this browser (double-click the corner grip to go back to the default size).
 */
export function DocHoverPreview({ doc, children }: { doc: Pick<PartDoc, "id" | "fileName" | "mime" | "title">; children: ReactNode }) {
  const kind = /\.pdf$/i.test(doc.fileName) || doc.mime === "application/pdf" ? "pdf" : /^image\//.test(doc.mime) || /\.(png|jpe?g|gif|webp|svg)$/i.test(doc.fileName) ? "image" : null;
  const url = api.parts.docUrl(doc.id, true);
  return <HoverPreview kind={kind} title={doc.fileName} alt={doc.title || doc.fileName} url={url} docId={doc.id} pageNos={[1, 2]}>{children}</HoverPreview>;
}

/** PDF page boxes to highlight: page number → [x, y, w, h] in PDF units (y = baseline from the bottom). */
export type PageMarks = Record<number, number[][]>;

/**
 * Hover preview of given pages of a PDF held in memory (e.g. the datasheet being read by Fill from OEM page), with the
 * text the values were read from highlighted. Same behaviour as the document preview (Shift keeps it open / resizes).
 */
export function PdfPagesPreview({ data, title, pageNos, marks, children }: { data: Uint8Array; title: string; pageNos: number[]; marks?: PageMarks; children: ReactNode }) {
  return <HoverPreview kind="pdf" title={title} alt={title} load={async () => data.slice()} pageNos={pageNos} marks={marks}>{children}</HoverPreview>;
}

function HoverPreview({ kind, title, alt, url, docId, load, pageNos, marks, children }: {
  kind: "pdf" | "image" | null; title: string; alt: string; url?: string; docId?: string; load?: () => Promise<Uint8Array>; pageNos: number[]; marks?: PageMarks; children: ReactNode;
}) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const over = useRef(false);
  const shift = useShift();
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const enter = () => {
    if (!kind) return;
    over.current = true;
    clear();
    if (!at) timer.current = window.setTimeout(() => setAt(anchor.current?.getBoundingClientRect() ?? null), OPEN_DELAY);
  };
  const leave = () => {
    over.current = false;
    clear();
    // Shift held: the preview stays (it closes when Shift is released with the mouse outside).
    if (shiftDown && at) return;
    timer.current = window.setTimeout(() => setAt(null), CLOSE_GRACE);
  };
  useEffect(() => {
    if (!shift && at && !over.current) {
      clear();
      timer.current = window.setTimeout(() => !over.current && setAt(null), CLOSE_GRACE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift]);
  useEffect(() => clear, []);
  return (
    <span ref={anchor} className="docprev-anchor" onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {at && kind && createPortal(<PreviewPopup title={title} alt={alt} url={url} docId={docId} load={load} pageNos={pageNos} marks={marks} kind={kind} rect={at} pinned={shift} onEnter={() => ((over.current = true), clear())} onLeave={leave} onClose={() => (clear(), setAt(null))} />, document.body)}
    </span>
  );
}

function PreviewPopup({ title, alt, url, docId, load, pageNos, marks, kind, rect, pinned, onEnter, onLeave, onClose }: {
  title: string; alt: string; url?: string; docId?: string; load?: () => Promise<Uint8Array>; pageNos: number[]; marks?: PageMarks;
  kind: "pdf" | "image"; rect: DOMRect; pinned: boolean; onEnter: () => void; onLeave: () => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(loadSize);
  // Pages are drawn for this height (re-drawn sharper when the preview is made taller).
  const [renderH, setRenderH] = useState(() => Math.min(1600, Math.max(PAGE_H, (size?.h ?? 0) - HEAD_H - 16)));
  // Resizing (native corner grip, enabled while Shift is held): a press on the grip, then the size at release is kept.
  const onGrip = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el || !pinned) return;
    const r0 = el.getBoundingClientRect();
    if (e.clientX < r0.right - 18 || e.clientY < r0.bottom - 18) return;
    const up = () => {
      window.removeEventListener("pointerup", up, true);
      const r = el.getBoundingClientRect();
      if (Math.abs(r.width - r0.width) < 2 && Math.abs(r.height - r0.height) < 2) return;
      const v = { w: Math.round(r.width), h: Math.round(r.height) };
      setSize(v);
      saveSize(v);
      const want = v.h - HEAD_H - 16;
      setRenderH((h) => (want > h * 1.15 ? Math.min(1600, want) : h));
    };
    window.addEventListener("pointerup", up, true);
  };
  const c1 = useRef<HTMLCanvasElement>(null);
  const c2 = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ pages: number; err: string; loading: boolean; shown: number[] }>({ pages: 0, err: "", loading: true, shown: [] });
  const pagesKey = pageNos.join(",");
  // Zoom 100–400 %: global (keeps the centre of the view) or onto the highlighted text (centred).
  const [zoom, setZoom] = useState(100);
  const [zmode, setZmode] = useState<"global" | "highlight">("global");
  const hasMarks = !!marks && Object.values(marks).some((m) => m.length);
  const pagesBox = useRef<HTMLDivElement>(null);
  const geo = useRef<{ page: number; h: number }[]>([]);
  const prevZoom = useRef(100);
  const cvStyle = zoom > 100 ? (size ? { height: `${zoom}%` } : { height: (PAGE_H * zoom) / 100 }) : undefined;
  const place = () => {
    const el = pagesBox.current;
    if (!el) return;
    if (zmode === "highlight" && hasMarks) {
      for (let i = 0; i < 2; i++) {
        const g = geo.current[i], cv = (i === 0 ? c1 : c2).current, ms = g && marks?.[g.page];
        if (!g || !cv || !ms?.length || cv.style.display === "none") continue;
        const s = cv.getBoundingClientRect().height / g.h;
        const [x, y, w, h] = ms[0];
        const r = cv.getBoundingClientRect(), c = el.getBoundingClientRect();
        el.scrollTo({ left: r.left - c.left + el.scrollLeft + (x + w / 2) * s - el.clientWidth / 2, top: r.top - c.top + el.scrollTop + (g.h - y - h / 2) * s - el.clientHeight / 2 });
        break;
      }
    } else if (prevZoom.current !== zoom) {
      const k = zoom / prevZoom.current;
      el.scrollTo({ left: (el.scrollLeft + el.clientWidth / 2) * k - el.clientWidth / 2, top: (el.scrollTop + el.clientHeight / 2) * k - el.clientHeight / 2 });
    }
    prevZoom.current = zoom;
  };
  useEffect(() => {
    requestAnimationFrame(place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zmode]);
  // Click outside or Esc closes (and unloads).
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        // This press only dismisses the preview (it must not also close the Edit part dialog behind it).
        e.stopPropagation();
        onClose();
      }
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  // The PDF stays loaded while the preview is open; the pages shown (a spread of 1 or 2 pages from `start`) can be
  // paged through: « » two pages, < > one page, or a page number.
  const span = Math.max(1, Math.min(2, pageNos.length));
  const [start, setStart] = useState(() => Math.max(1, pageNos[0] ?? 1));
  useEffect(() => setStart(Math.max(1, pageNos[0] ?? 1)), [pagesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pdfDoc, setPdfDoc] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (kind !== "pdf") return;
    const ac = new AbortController();
    let task: { destroy: () => Promise<void> } | null = null;
    let live = true;
    (async () => {
      try {
        let data: Uint8Array;
        if (load) data = await load();
        else {
          const res = await fetch(url!, { signal: ac.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = new Uint8Array(await res.arrayBuffer());
        }
        if (!live) return;
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const lt = pdfjs.getDocument({ data });
        task = lt;
        const d = await lt.promise;
        if (!live) return void lt.destroy();
        setStart((st) => Math.min(st, d.numPages));
        setState((x) => ({ ...x, pages: d.numPages, err: "" }));
        setPdfDoc(d);
      } catch (e) {
        const m = (e as Error).name;
        if (live && m !== "AbortError") setState({ pages: 0, err: (e as Error).message, loading: false, shown: [] });
      }
    })();
    return () => {
      // Unload: abort the download, destroy the document, free the canvases.
      live = false;
      ac.abort();
      setPdfDoc(null);
      void task?.destroy();
      for (const c of [c1.current, c2.current]) if (c) (c.width = 0), (c.height = 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind]);
  useEffect(() => {
    const d = pdfDoc;
    if (!d) return;
    const tasks: { cancel: () => void }[] = [];
    let live = true;
    (async () => {
      try {
        const first = Math.min(Math.max(1, start), d.numPages);
        const shown = Array.from({ length: span }, (_, k) => first + k).filter((n) => n <= d.numPages);
        setState((x) => ({ ...x, pages: d.numPages, err: "", loading: true, shown }));
        for (let i = 1; i <= shown.length; i++) {
          const pageNo = shown[i - 1];
          const page = await d.getPage(pageNo);
          if (!live) return;
          const base = page.getViewport({ scale: 1 });
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          // Zoom: drawn sharper (capped) and shown larger; the pages area scrolls.
          const vp = page.getViewport({ scale: (Math.min(3200, renderH * (zoom / 100)) / base.height) * dpr });
          geo.current[i - 1] = { page: pageNo, h: base.height };
          const cv = (i === 1 ? c1 : c2).current;
          if (!cv) return;
          cv.width = Math.ceil(vp.width);
          cv.height = Math.ceil(vp.height);
          const ctx = cv.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, cv.width, cv.height);
          const t = page.render({ canvas: cv, canvasContext: ctx, viewport: vp });
          tasks.push(t);
          await t.promise;
          // Highlight where the values were read (text boxes of the source lines).
          const ms = marks?.[pageNo] ?? [];
          if (ms.length) {
            ctx.save();
            ctx.fillStyle = "rgba(255, 196, 0, 0.35)";
            ctx.strokeStyle = "rgba(230, 120, 0, 0.9)";
            ctx.lineWidth = Math.max(1, dpr);
            for (const [x, y, w, h] of ms) {
              const [x1, y1] = vp.convertToViewportPoint(x - 1, y - h * 0.25);
              const [x2, y2] = vp.convertToViewportPoint(x + w + 1, y + h * 0.95);
              const rx = Math.min(x1, x2), ry = Math.min(y1, y2), rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
              ctx.fillRect(rx, ry, rw, rh);
              ctx.strokeRect(rx, ry, rw, rh);
            }
            ctx.restore();
          }
        }
        if (live) {
          setState((x) => ({ ...x, loading: false }));
          requestAnimationFrame(place);
        }
      } catch (e) {
        const m = (e as Error).name;
        if (live && m !== "RenderingCancelledException") setState((x) => ({ ...x, err: (e as Error).message, loading: false }));
      }
    })();
    return () => {
      live = false;
      tasks.forEach((t) => t.cancel());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, start, span, renderH, zoom]);
  const n = state.pages;
  const go = (to: number) => n && to >= 1 && to <= n && to !== start && setStart(to);
  const [pageIn, setPageIn] = useState("");
  useEffect(() => setPageIn(String(start)), [start]);
  // Keep the popup's size while paging (a spread ending on a single last page must not shrink it from under the mouse).
  const [lock, setLock] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!state.loading && box.current && !lock) {
      const r = box.current.getBoundingClientRect();
      if (r.width > 40) setLock({ w: Math.round(r.width), h: Math.round(r.height) });
    }
  }, [state.loading, lock]);
  // Place below the link, or above when there is no room; keep inside the window.
  const w = Math.min(window.innerWidth - 24, size?.w ?? 2 * Math.round(PAGE_H * 0.78) + 40);
  const h = Math.min(window.innerHeight - 24, size?.h ?? PAGE_H + 64);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - w - 12));
  const below = rect.bottom + 6 + h <= window.innerHeight;
  const top = below ? rect.bottom + 6 : Math.max(12, rect.top - 6 - h);
  return (
    <div ref={box} className={`docprev${pinned ? " pinned" : ""}${size ? " sized" : ""}`} role="dialog" aria-label={`Preview of ${title}`}
      style={size ? { left, top, width: w, height: h } : { left, top, maxWidth: w, minWidth: lock ? Math.min(lock.w, w) : undefined, minHeight: lock?.h }} onMouseEnter={onEnter} onMouseLeave={onLeave} onPointerDown={onGrip}
      onDoubleClick={(e) => {
        // Double-click the corner grip area: back to the default size.
        const r = box.current!.getBoundingClientRect();
        if (pinned && e.clientX > r.right - 18 && e.clientY > r.bottom - 18) (setSize(null), saveSize(null), setRenderH(PAGE_H));
      }}>
      <div className="docprev-h">
        <b title={title}>{title}</b>
        <span className="muted">{kind === "pdf" ? (state.pages ? `${state.shown.length > 1 ? "pages" : "page"} ${state.shown.length > 1 && state.shown[1] === state.shown[0] + 1 ? `${state.shown[0]}–${state.shown[1]}` : state.shown.join(", ")} of ${state.pages}` : "") : "image"}</span>
        <span className="docprev-hint muted">{pinned ? "Shift held: drag the corner to resize · double-click it to reset" : "Hold Shift to keep open and resize"}</span>
        {kind === "pdf" && (
          <button type="button" className="btn-ghost docprev-open" title="Open in a new tab: full-window viewer (1 / 2 pages, continuous scrolling, zoom, advanced search)" aria-label="Open in a new tab"
            onClick={async () => {
              try {
                const view = { zoom, zmode, span };
                await openPdfViewer(docId ? { docId, title, page: start, marks, view } : { data: load ? await load() : undefined, title, page: start, marks, view });
              } catch {
                /* the preview stays */
              }
            }}>⧉</button>
        )}
        {kind === "pdf" && n > 1 && (
          <span className="docprev-nav" role="group" aria-label="Pages">
            {/* « » two pages (nothing at the first page / when no more than one page is left), < > one page, or a page number. */}
            <button type="button" className="btn-ghost" aria-label="Back 2 pages" title="Back 2 pages" disabled={start <= 1} onClick={() => go(Math.max(1, start - 2))}>«</button>
            <button type="button" className="btn-ghost" aria-label="Back 1 page" title="Back 1 page" disabled={start <= 1} onClick={() => go(start - 1)}>&lt;</button>
            <input type="text" inputMode="numeric" aria-label="Go to page" title={`Go to page (1–${n}), Enter`} value={pageIn}
              onChange={(e) => setPageIn(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = Number(pageIn);
                  if (v >= 1 && v <= n) go(v);
                  else setPageIn(String(start));
                }
                e.stopPropagation();
              }}
              onBlur={() => {
                const v = Number(pageIn);
                if (v >= 1 && v <= n) go(v);
                else setPageIn(String(start));
              }} />
            <span className="muted">/ {n}</span>
            <button type="button" className="btn-ghost" aria-label="Forward 1 page" title="Forward 1 page" disabled={start >= n} onClick={() => go(start + 1)}>&gt;</button>
            <button type="button" className="btn-ghost" aria-label="Forward 2 pages" title="Forward 2 pages" disabled={start + 2 > n} onClick={() => go(start + 2)}>»</button>
          </span>
        )}
      </div>
      {kind === "pdf" && !state.err && (
        <div className="docprev-zoom">
          <ZoomControls zoom={zoom} zmode={zmode} canHighlight={hasMarks} onZoom={setZoom} onMode={setZmode} />
        </div>
      )}
      {kind === "image" ? (
        <div className="docprev-pages"><img src={url} alt={alt} style={size ? { maxHeight: "100%", maxWidth: "100%" } : { maxHeight: PAGE_H, maxWidth: "100%" }} /></div>
      ) : state.err ? (
        <div className="docprev-msg chip err">Preview not available: {state.err}</div>
      ) : (
        <div className={`docprev-pages${zoom > 100 ? " zoomed" : ""}`} ref={pagesBox} style={zoom > 100 && !size ? { height: PAGE_H + 18 } : undefined}>
          <canvas ref={c1} aria-label={`Page ${state.shown[0] ?? 1}`} style={cvStyle} />
          <canvas ref={c2} aria-label={`Page ${state.shown[1] ?? 2}`} style={state.shown.length < 2 ? { display: "none" } : cvStyle} />
          {state.loading && <span className="docprev-load muted">Loading…</span>}
        </div>
      )}
    </div>
  );
}
