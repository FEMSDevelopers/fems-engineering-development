import { compilePdfSearch, searchSpans, type PdfSearchMode } from "@fpl/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPdf, type PageMarks } from "./pdfStore";

/**
 * Full-window PDF viewer (opened in a new tab from a document preview): the preview's page buttons, zoom bar and
 * global / highlighted-content zoom, plus 1 or 2 pages side by side, continuous (partial-page) scrolling, and an
 * advanced search whose hits are listed on the left and highlighted on the pages.
 */
interface Line { text: string; items: { start: number; end: number; x: number; y: number; w: number; h: number }[] }
interface Hit { id: number; page: number; boxes: number[][]; before: string; match: string; after: string }

const SETTINGS = "fpl.viewer.settings3";
/** Viewer settings (this browser). zoom: % of the actual page size, or "fit" (fit to window — also the smallest zoom). */
interface Settings { span: 1 | 2; continuous: boolean; zoom: number | "fit"; zmode: "global" | "highlight"; panel: boolean; recent: number[]; logZoom: boolean }
// Defaults: highlighted-content zoom, 2 pages side by side, fit to window.
const DEFAULTS: Settings = { span: 2, continuous: true, zoom: "fit", zmode: "highlight", panel: true, recent: [], logZoom: true };
const loadSettings = (): Settings => {
  try {
    const saved = localStorage.getItem(SETTINGS);
    if (!saved) {
      // Earlier settings: keep the recent zooms, history option, panel and scrolling; the new defaults apply to the rest.
      const old = JSON.parse(localStorage.getItem("fpl.viewer.settings2") ?? "{}") as Partial<Settings>;
      return { ...DEFAULTS, recent: old.recent ?? [], logZoom: old.logZoom ?? true, panel: old.panel ?? true, continuous: old.continuous ?? true };
    }
    return { ...DEFAULTS, ...(JSON.parse(saved) as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
};
/** A search result that was clicked: enough to go back to it, or to re-run its whole search. */
interface LogItem { q: string; mode: PdfSearchMode; matchCase: boolean; wholeWord: boolean; page: number; boxes: number[][]; before: string; match: string; after: string; zoom: number; zmode: "global" | "highlight"; at: number }
const PX = 96 / 72; // CSS px per PDF point at 100 %
const sameBox = (a?: number[], b?: number[]) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 0.6);

/** Text lines of a page (items on one baseline, left to right) with each item's span in the line text and its box. */
async function pageLines(doc: PDFDocumentProxy, n: number): Promise<Line[]> {
  const pg = await doc.getPage(n);
  const tc = await pg.getTextContent();
  const rows = new Map<number, { s: string; x: number; y: number; w: number; h: number }[]>();
  for (const it of tc.items as { str: string; transform: number[]; width: number; height?: number }[]) {
    if (!it.str) continue;
    const k = Math.round(it.transform[5] / 2.5);
    (rows.get(k) ?? rows.set(k, []).get(k)!).push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.abs(it.transform[3]) || 8 });
  }
  return [...rows.keys()].sort((a, b) => b - a).map((k) => {
    const its = rows.get(k)!.sort((a, b) => a.x - b.x);
    let text = "";
    let last: { x: number; w: number } | null = null;
    const items: Line["items"] = [];
    for (const it of its) {
      if (last && it.x - (last.x + last.w) > 1.5 && !text.endsWith(" ") && !it.s.startsWith(" ")) text += " ";
      items.push({ start: text.length, end: text.length + it.s.length, x: it.x, y: it.y, w: it.w, h: it.h });
      text += it.s;
      last = it;
    }
    return { text, items };
  });
}
/** Boxes (PDF units) of a span of a line, cut inside items in proportion to their characters. */
function spanBoxes(l: Line, a: number, b: number): number[][] {
  const out: number[][] = [];
  for (const it of l.items) {
    const s = Math.max(a, it.start), e = Math.min(b, it.end);
    if (s >= e) continue;
    const cw = it.w / Math.max(1, it.end - it.start);
    out.push([it.x + (s - it.start) * cw, it.y, (e - s) * cw, it.h]);
  }
  return out;
}

export function PdfViewer() {
  const q0 = new URLSearchParams(location.search);
  const title = q0.get("title") || "PDF";
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [err, setErr] = useState("");
  const [marks, setMarks] = useState<PageMarks>(() => {
    try {
      return JSON.parse(q0.get("marks") ?? "{}") as PageMarks;
    } catch {
      return {};
    }
  });
  const [st, setSt] = useState(loadSettings);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS, JSON.stringify(st));
    } catch {
      /* ignore */
    }
  }, [st]);
  const set = (p: Partial<typeof st>) => setSt((s) => ({ ...s, ...p }));
  const [page, setPage] = useState(Math.max(1, Number(q0.get("page")) || 1));
  const n = doc?.numPages ?? 0;
  useEffect(() => {
    document.title = `${title} — PDF viewer`;
    let live = true;
    let d: PDFDocumentProxy | null = null;
    (async () => {
      try {
        let data: Uint8Array;
        const key = q0.get("key");
        if (key) {
          const e = await getPdf(key);
          if (!e) throw new Error("This preview is no longer available — open it again from the application");
          data = e.data;
          if (e.marks) setMarks(e.marks);
        } else {
          const id = q0.get("doc");
          if (!id) throw new Error("No document given");
          const r = await fetch(`/api/part-docs/${id}/file?inline=1`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          data = new Uint8Array(await r.arrayBuffer());
        }
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        d = await pdfjs.getDocument({ data }).promise;
        if (!live) return void d.cleanup();
        setDoc(d);
        setPage((p) => Math.min(p, d!.numPages));
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    })();
    return () => {
      live = false;
      void d?.cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── text of every page (search) ──
  const [lines, setLines] = useState<Line[][] | null>(null);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    (async () => {
      const all: Line[][] = [];
      for (let i = 1; i <= doc.numPages; i++) all.push(await pageLines(doc, i));
      if (live) setLines(all);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [doc]);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<PdfSearchMode>("text");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const re = useMemo(() => compilePdfSearch(q, { mode, matchCase, wholeWord }), [q, mode, matchCase, wholeWord]);
  const hits = useMemo<Hit[]>(() => {
    if (!lines || !re || "error" in re) return [];
    const out: Hit[] = [];
    lines.forEach((pl, pi) => pl.forEach((l) => {
      for (const [a, b] of searchSpans(re, l.text, 2000)) {
        if (out.length >= 2000) return;
        out.push({ id: out.length, page: pi + 1, boxes: spanBoxes(l, a, b), before: l.text.slice(Math.max(0, a - 40), a), match: l.text.slice(a, b), after: l.text.slice(b, b + 40) });
      }
    }));
    return out;
  }, [lines, re]);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => setActive(null), [hits]);
  // A result recalled from the history (its whole search re-run): selected once the hits are there.
  const recallRef = useRef<LogItem | null>(null);
  useEffect(() => {
    const e = recallRef.current;
    if (!e || !lines) return;
    recallRef.current = null;
    const h = hits.find((x) => x.page === e.page && sameBox(x.boxes[0], e.boxes[0])) ?? hits.find((x) => x.page === e.page && x.match === e.match);
    if (h) pick(h, false);
    else showFocus(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits]);
  // Result shown from the history without re-running its search.
  const [focus, setFocus] = useState<{ page: number; boxes: number[][] } | null>(null);
  const hitMarks = useMemo(() => {
    const m: PageMarks = {};
    for (const h of hits) (m[h.page] ??= []).push(...h.boxes);
    return m;
  }, [hits]);

  // ── layout ──
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1000, h: 700 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);
  const [p1, setP1] = useState({ w: 612, h: 792 }); // page 1 in PDF points
  useEffect(() => {
    if (doc) void doc.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setP1({ w: v.width, h: v.height });
    });
  }, [doc]);
  const gap = 12;
  // Zoom = % of the actual page size. Fit to window (whole page — or both pages — visible) is the smallest zoom.
  const fitZoom = Math.max(5, Math.floor(Math.min((box.h - 32) / (p1.h * PX), (box.w - 32 - gap * (st.span - 1)) / st.span / (p1.w * PX)) * 100));
  const maxZoom = Math.max(400, fitZoom);
  const z = st.zoom === "fit" ? fitZoom : Math.min(maxZoom, Math.max(fitZoom, st.zoom));
  const pageH = p1.h * PX * (z / 100);
  const setZoom = (v: number | "fit") => set({ zoom: v === "fit" || v <= fitZoom ? "fit" : Math.round(v) });
  // Recently used zooms (kept when a zoom stays for a moment).
  useEffect(() => {
    if (st.zoom === "fit") return;
    const t = setTimeout(() => setSt((x) => (x.recent[0] === z ? x : { ...x, recent: [z, ...x.recent.filter((r) => r !== z)].slice(0, 8) })), 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [z]);
  // The view the preview showed (page, zoom relative to fit, highlighted / global, pages), for "Preview view".
  const pv = useMemo(() => ({ page: Math.max(1, Number(q0.get("page")) || 1), zoom: Math.max(100, Number(q0.get("pz")) || 100), zmode: (q0.get("pm") === "highlight" ? "highlight" : "global") as Settings["zmode"], span: (q0.get("ps") === "2" ? 2 : 1) as 1 | 2 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);
  const first = st.span === 2 && !st.continuous ? page : page;
  const shown = st.continuous ? Array.from({ length: n }, (_, i) => i + 1) : Array.from({ length: st.span }, (_, k) => first + k).filter((x) => x <= n);

  const pageEl = (p: number) => scroller.current?.querySelector<HTMLElement>(`[data-page="${p}"]`) ?? null;
  const go = useCallback((to: number, scroll = true) => {
    if (!n) return;
    const t = Math.min(Math.max(1, to), n);
    setPage(t);
    if (st.continuous && scroll) requestAnimationFrame(() => pageEl(t)?.scrollIntoView({ block: "start" }));
  }, [n, st.continuous]);
  // Continuous: the page at the top of the window is the current one.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !st.continuous) return;
    const f = () => {
      const top = el.getBoundingClientRect().top + 40;
      let cur = 1;
      el.querySelectorAll<HTMLElement>("[data-page]").forEach((x) => {
        if (x.getBoundingClientRect().top <= top) cur = Number(x.dataset.page);
      });
      // Two pages in view: rows are 1–2, 3–4 …; the row's first page is the current one.
      setPage(st.span === 2 ? cur - ((cur - 1) % 2) : cur);
    };
    el.addEventListener("scroll", f, { passive: true });
    return () => el.removeEventListener("scroll", f);
  }, [st.continuous, st.span, doc]);

  // Highlighted-content zoom: the active hit (else the first highlight from the preview) is centred in the window.
  const target = useMemo(() => {
    if (active != null && hits[active]) return { page: hits[active].page, box: hits[active].boxes[0] };
    if (focus) return { page: focus.page, box: focus.boxes[0] };
    const p = Object.keys(marks).map(Number).sort((a, b) => a - b)[0];
    return p ? { page: p, box: marks[p][0] } : null;
  }, [active, hits, marks, focus]);
  const centre = useCallback(() => {
    const el = scroller.current;
    if (!el || !target?.box) return;
    const cv = pageEl(target.page)?.querySelector("canvas");
    if (!cv || !cv.dataset.s) return;
    const s = Number(cv.dataset.s), h = Number(cv.dataset.h);
    const r = cv.getBoundingClientRect(), c = el.getBoundingClientRect();
    const [x, y, w, bh] = target.box;
    const cx = r.left - c.left + el.scrollLeft + (x + w / 2) * s;
    const cy = r.top - c.top + el.scrollTop + (h - y - bh / 2) * s;
    el.scrollTo({ left: cx - el.clientWidth / 2, top: cy - el.clientHeight / 2 });
  }, [target]);
  // Global zoom keeps the point at the centre of the window; highlighted-content zoom centres the highlight.
  const prevZoom = useRef(z);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (st.zmode === "highlight" && target) {
      requestAnimationFrame(() => requestAnimationFrame(centre));
    } else if (prevZoom.current !== z) {
      const k = z / prevZoom.current;
      const cx = (el.scrollLeft + el.clientWidth / 2) * k, cy = (el.scrollTop + el.clientHeight / 2) * k;
      requestAnimationFrame(() => el.scrollTo({ left: cx - el.clientWidth / 2, top: cy - el.clientHeight / 2 }));
    }
    prevZoom.current = z;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [z, st.zmode]);
  const showPage = (p: number) => {
    if (st.continuous) requestAnimationFrame(() => pageEl(p)?.scrollIntoView({ block: "center" }));
    else setPage(st.span === 2 && p === page + 1 ? page : p);
  };

  // ── history of clicked search results (20 most recent, per document, this browser) ──
  const LOG_KEY = `fpl.viewer.log.${q0.get("doc") || title}`;
  const [log, setLog] = useState<LogItem[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as LogItem[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch {
      /* ignore */
    }
  }, [log, LOG_KEY]);
  const pick = (h: Hit, record = true) => {
    setActive(h.id);
    setFocus(null);
    showPage(h.page);
    if (record) {
      const e: LogItem = { q, mode, matchCase, wholeWord, page: h.page, boxes: h.boxes, before: h.before, match: h.match, after: h.after, zoom: z, zmode: st.zmode, at: Date.now() };
      setLog((l) => [e, ...l.filter((x) => !(x.q === e.q && x.mode === e.mode && x.page === e.page && sameBox(x.boxes[0], e.boxes[0])))].slice(0, 20));
    }
    if (st.zmode === "highlight") setTimeout(centre, 60);
  };
  /** Zoom of a history item (when "Keep zoom with history" is on). */
  const logZoomOf = (e: LogItem) => {
    if (st.logZoom && e.zoom) set({ zoom: e.zoom <= fitZoom ? "fit" : e.zoom, zmode: e.zmode });
  };
  /** Go to a result (highlighted) without changing the current search. */
  const showFocus = (e: LogItem) => {
    setActive(null);
    setFocus({ page: e.page, boxes: e.boxes });
    showPage(e.page);
    setTimeout(centre, 150);
  };
  const invoke = (e: LogItem) => {
    logZoomOf(e);
    showFocus(e);
  };
  /** Click and hold 0.4 s: re-run the whole search, select the result in the list and go to it. */
  const recall = (e: LogItem) => {
    logZoomOf(e);
    set({ panel: true });
    if (e.q === q && e.mode === mode && e.matchCase === matchCase && e.wholeWord === wholeWord) {
      // Same search as now: the hits do not change, so select at once.
      const h = hits.find((x) => x.page === e.page && sameBox(x.boxes[0], e.boxes[0]));
      if (h) pick(h, false);
      else showFocus(e);
      return;
    }
    recallRef.current = e;
    setQ(e.q);
    setMode(e.mode);
    setMatchCase(e.matchCase);
    setWholeWord(e.wholeWord);
  };
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => {
    if (!logOpen) return;
    const f = (e: MouseEvent) => !(e.target as HTMLElement).closest(".pdfv-logbar, .pdfv-hitprev") && setLogOpen(false);
    window.addEventListener("mousedown", f);
    return () => window.removeEventListener("mousedown", f);
  }, [logOpen]);
  // Hover a search result: preview of its place on the page (Shift keeps it open and lets you resize it).
  const shiftHeld = useShiftHeld();
  const hov = useHitHover(shiftHeld);
  useEffect(() => {
    if (active == null) return;
    document.querySelector(".pdfv-hits li.sel")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    if (st.zmode === "highlight" && active != null) setTimeout(centre, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, page]);
  // Keys: ← → pages, Ctrl+F search, F3 / Enter next hit.
  const searchIn = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        set({ panel: true });
        setTimeout(() => searchIn.current?.focus(), 0);
        return;
      }
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      // One page, or two when two pages are in view.
      if (e.key === "ArrowRight" || e.key === "PageDown") go(page + st.span);
      if (e.key === "ArrowLeft" || e.key === "PageUp") go(page - st.span);
      if (e.key === "F3" && hits.length) {
        e.preventDefault();
        pick(hits[((active ?? -1) + (e.shiftKey ? hits.length - 1 : 1)) % hits.length]);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const [pageIn, setPageIn] = useState("1");
  useEffect(() => setPageIn(String(page)), [page]);
  const step = st.continuous ? 1 : st.span;
  const errText = re && "error" in re ? re.error : "";
  return (
    <div className="pdfv">
      <header className="pdfv-bar">
        <button type="button" className="btn-ghost" aria-pressed={st.panel} onClick={() => set({ panel: !st.panel })} title="Search panel (Ctrl+F)">🔍</button>
        <b className="pdfv-title" title={title}>{title}</b>
        <span className="pdfv-nav" role="group" aria-label="Pages">
          <button type="button" className="btn-ghost" aria-label="Back 2 pages" disabled={page <= 1} onClick={() => go(page - 2)}>«</button>
          <button type="button" className="btn-ghost" aria-label={st.span === 2 ? "Back 2 pages (one spread)" : "Back 1 page"} title={st.span === 2 ? "Back 2 pages (two pages in view)" : "Back 1 page"} disabled={page <= 1} onClick={() => go(page - st.span)}>&lt;</button>
          <input type="text" inputMode="numeric" aria-label="Go to page" value={pageIn} onChange={(e) => setPageIn(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && go(Number(pageIn) || page)} onBlur={() => setPageIn(String(page))} />
          <span className="muted">/ {n || "…"}</span>
          <button type="button" className="btn-ghost" aria-label={st.span === 2 ? "Forward 2 pages (one spread)" : "Forward 1 page"} title={st.span === 2 ? "Forward 2 pages (two pages in view)" : "Forward 1 page"} disabled={page + st.span > n} onClick={() => go(page + st.span)}>&gt;</button>
          <button type="button" className="btn-ghost" aria-label="Forward 2 pages" disabled={page + 2 > n} onClick={() => go(page + 2)}>»</button>
        </span>
        <span className="seg mini" role="group" aria-label="Pages side by side">
          <button type="button" aria-pressed={st.span === 1} onClick={() => set({ span: 1 })} title="One page">1 page</button>
          <button type="button" aria-pressed={st.span === 2} onClick={() => set({ span: 2 })} title="Two pages side by side">2 pages</button>
        </span>
        <label className="chk-l" title="On: every page in one scrolling column (partial pages); off: one page / spread at a time">
          <input type="checkbox" checked={st.continuous} onChange={(e) => (set({ continuous: e.target.checked }), setTimeout(() => go(page), 50))} /> Continuous scrolling
        </label>
        <ZoomControls zoom={z} min={fitZoom} max={maxZoom} zmode={st.zmode} canHighlight onZoom={setZoom} onMode={(m) => set({ zmode: m })}
          onFit={() => setZoom("fit")} fitOn={st.zoom === "fit"}>
          <select className="zoomrecent" aria-label="Recent zooms" value="" title="Recently used zooms" onChange={(e) => e.target.value && setZoom(Number(e.target.value))}>
            <option value="">Recent ▾</option>
            {st.recent.map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
          <button type="button" className="btn-ghost" title={`Preview view: page ${pv.page}, the preview's zoom (${pv.zoom > 100 ? `${pv.zoom}% of fit` : "fit to window"}), ${pv.zmode === "highlight" ? "highlighted" : "global"} zoom`}
            onClick={() => {
              set({ zoom: pv.zoom > 100 ? Math.round((fitZoom * pv.zoom) / 100) : "fit", zmode: pv.zmode, span: pv.span });
              setActive(null);
              setFocus(null);
              setTimeout(() => go(pv.page), 30);
            }}>▣ Preview view</button>
        </ZoomControls>
        <span className="pdfv-logbar">
          <button type="button" aria-expanded={logOpen} disabled={!log.length} onClick={() => setLogOpen((v) => !v)} title="The 20 most recent search results you clicked (this document): click to go back to one, click and hold 0.4 s to re-run its whole search">
            🕘 History ({log.length}) ▾
          </button>
          <label className="chk-l" title="On: going back to a result also restores the zoom it was seen at. Off: the zoom stays as it is.">
            <input type="checkbox" checked={st.logZoom} onChange={(e) => set({ logZoom: e.target.checked })} /> Keep zoom with history
          </label>
          {logOpen && log.length > 0 && (
            <div className="pdfv-log" role="menu" aria-label="Search result history">
              <div className="muted pdfv-help">Click: go to the result · click and hold 0.4 s: re-run its search and select it</div>
              {log.map((e) => (
                <HoldItem key={`${e.at}`} onClick={() => (hov.close(), invoke(e), setLogOpen(false))} onHold={() => (hov.close(), recall(e), setLogOpen(false))}
                  onEnter={(el) => {
                    // The preview slides to the right of the history menu (below it when there is no room), level with the item.
                    const m = el.closest(".pdfv-log")?.getBoundingClientRect() ?? el.getBoundingClientRect();
                    const r = el.getBoundingClientRect();
                    hov.enter({ id: -1, page: e.page, boxes: e.boxes, before: e.before, match: e.match, after: e.after }, el,
                      window.innerWidth - m.right > 300 ? new DOMRect(m.right, r.top, 0, r.height) : new DOMRect(m.left - 8, m.bottom + 48, 0, 0));
                  }}
                  onLeave={hov.leave}
                  title={`“${e.q}” (${e.mode === "regex" ? "regex" : "text"}${e.matchCase ? ", Aa" : ""}${e.wholeWord ? ", whole word" : ""}) · page ${e.page}${st.logZoom ? ` · ${e.zoom}%${e.zmode === "highlight" ? " highlighted" : ""}` : ""}`}>
                  <span className="pg">p. {e.page}</span>
                  <span className="ctx"><span className="lq">{e.q}</span> {e.before.slice(-24)}<mark>{e.match}</mark>{e.after.slice(0, 24)}</span>
                </HoldItem>
              ))}
              <div className="toolbar" style={{ justifyContent: "flex-end" }}><button type="button" className="btn-ghost" onClick={() => (setLog([]), setLogOpen(false))}>Clear history</button></div>
            </div>
          )}
        </span>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>← → {st.span === 2 ? "2 pages" : "page"} · Ctrl+F search · F3 next hit · hover a result to preview (Shift keeps it)</span>
      </header>
      <div className="pdfv-main">
        {st.panel && (
          <aside className="pdfv-side" aria-label="Search">
            <input ref={searchIn} type="search" aria-label="Search the PDF" placeholder={mode === "regex" ? "Python regex, e.g. (?P<v>\\d+)\\s?V\\b" : "Search… e.g. 2?0 V|UL*489"} value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && hits.length && pick(hits[((active ?? -1) + (e.shiftKey ? hits.length - 1 : 1)) % hits.length])} />
            <div className="pdfv-opts">
              <span className="seg mini" role="group" aria-label="Search syntax">
                <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")} title="Text: * any characters, ? one character, | alternatives, &quot;…&quot; literal">Text</button>
                <button type="button" aria-pressed={mode === "regex"} onClick={() => setMode("regex")} title="Python re syntax: (?P<name>…), (?P=name), \A \Z, (?i) (?s) (?m); character classes, quantifiers, look-arounds">Regex (Python)</button>
              </span>
              <label className="chk-l" title="Match case"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Aa</label>
              <label className="chk-l" title="Whole words only"><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Whole word</label>
            </div>
            <div className="muted pdfv-help">
              {mode === "text"
                ? <>Text · <code>*</code> any characters · <code>?</code> one character · <code>|</code> or · <code>"…"</code> literal</>
                : <>Python <code>re</code> · <code>\d \w \s</code> · <code>[a-z]</code> · <code>{"{2,4}"}</code> · <code>(?P&lt;name&gt;…)</code> · <code>(?i)</code> · look-arounds</>}
            </div>
            {errText && <div className="errtxt" style={{ fontSize: 12 }}>{errText}</div>}
            <div className="pdfv-count muted">{!lines ? "Reading the text…" : q.trim() && !errText ? `${hits.length}${hits.length >= 2000 ? "+" : ""} match${hits.length === 1 ? "" : "es"} on ${new Set(hits.map((h) => h.page)).size} page(s)` : ""}</div>
            <ol className="pdfv-hits">
              {hits.slice(0, 1000).map((h) => (
                <li key={h.id} className={active === h.id ? "sel" : undefined}>
                  <button type="button" onClick={() => pick(h)} onMouseEnter={(e) => hov.enter(h, e.currentTarget)} onMouseLeave={hov.leave}>
                    <span className="pg">p. {h.page}</span>
                    <span className="ctx">{h.before}<mark>{h.match}</mark>{h.after}</span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
        <div className={`pdfv-pages${st.continuous ? " cont" : ""}`} ref={scroller} style={{ ["--pdfv-cols" as string]: st.span }}>
          {err ? <div className="errtxt" style={{ margin: 24 }}>{err}</div> : !doc ? <div className="muted" style={{ margin: 24 }}>Loading…</div> : (
            <div className="pdfv-grid" style={{ gridTemplateColumns: `repeat(${Math.min(st.span, shown.length || 1)}, max-content)`, gap }}>
              {shown.map((p) => (
                <PageCanvas key={p} doc={doc} pageNo={p} cssH={pageH} lazy={st.continuous} root={scroller}
                  marks={[...(marks[p] ?? [])]} hits={hitMarks[p] ?? []} active={active != null && hits[active]?.page === p ? hits[active].boxes : focus?.page === p ? focus.boxes : []}
                  onDrawn={() => st.zmode === "highlight" && target?.page === p && centre()} />
              ))}
            </div>
          )}
        </div>
      </div>
      {hov.at && doc && <HitPreview doc={doc} hit={hov.at.hit} rect={hov.at.rect} pinned={shiftHeld} onEnter={hov.keep} onLeave={hov.leave} onClose={hov.close} />}
      {!st.continuous && n > 0 && <div className="pdfv-foot muted">Page{shown.length > 1 ? "s" : ""} {shown.join("–")} of {n} · step {step}</div>}
    </div>
  );
}

/** A history entry: click, or click and hold 0.4 s for the second action. */
function HoldItem({ onClick, onHold, title, children, onEnter, onLeave }: { onClick: () => void; onHold: () => void; title: string; children: React.ReactNode; onEnter?: (el: HTMLElement) => void; onLeave?: () => void }) {
  const t = useRef(0);
  const held = useRef(false);
  const [holding, setHolding] = useState(false);
  const stop = () => (window.clearTimeout(t.current), setHolding(false));
  return (
    <button type="button" role="menuitem" className={`pdfv-logitem${holding ? " holding" : ""}`} title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        held.current = false;
        setHolding(true);
        t.current = window.setTimeout(() => ((held.current = true), setHolding(false), onHold()), 400);
      }}
      onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onMouseEnter={(e) => onEnter?.(e.currentTarget)} onMouseLeave={() => onLeave?.()}
      onClick={() => (held.current ? (held.current = false) : onClick())}>{children}</button>
  );
}

/** Zoom bar (min–max %, default 100–400) and the global / highlighted-content switch (also used by the document preview). */
export function ZoomControls({ zoom, min = 100, max = 400, zmode, canHighlight, onZoom, onMode, onFit, fitOn, children }: {
  zoom: number; min?: number; max?: number; zmode: "global" | "highlight"; canHighlight: boolean; onZoom: (z: number) => void; onMode: (m: "global" | "highlight") => void;
  /** Fit to window (the smallest zoom). */
  onFit?: () => void; fitOn?: boolean; children?: React.ReactNode;
}) {
  return (
    <span className="zoomctl" role="group" aria-label="Zoom">
      <span className="seg mini" title="Global: zoom the whole page (keeps the centre of the view) · Highlighted: zoom onto the highlighted text">
        <button type="button" aria-pressed={zmode === "global"} onClick={() => onMode("global")}>Global</button>
        <button type="button" aria-pressed={zmode === "highlight"} disabled={!canHighlight} onClick={() => onMode("highlight")} title={canHighlight ? "Zoom onto the highlighted text" : "No highlighted text (search, or open from a value's 🎞️)"}>Highlighted</button>
      </span>
      {onFit && <button type="button" className="btn-ghost" aria-pressed={!!fitOn} onClick={onFit} title={`Fit to window (${min} %) — the smallest zoom: the whole page is visible`}>⤢ Fit</button>}
      <button type="button" className="btn-ghost" aria-label="Zoom out" disabled={zoom <= min} onClick={() => onZoom(Math.max(min, zoom - 25))}>−</button>
      <input type="range" min={min} max={max} step={1} value={zoom} aria-label={onFit ? "Zoom" : "Zoom (100–400 %)"} title={`${min}–${max} %`} onChange={(e) => onZoom(Number(e.target.value))} />
      <button type="button" className="btn-ghost" aria-label="Zoom in" disabled={zoom >= max} onClick={() => onZoom(Math.min(max, zoom + 25))}>+</button>
      <button type="button" className="btn-ghost zoomval" title={onFit ? "Fit to window" : "Back to 100 %"} onClick={() => (onFit ? onFit() : onZoom(min))}>{zoom}%</button>
      {children}
    </span>
  );
}

/** One page: rendered when (nearly) visible, at the CSS height given; search hits, the active hit and marks drawn on it. */
function PageCanvas({ doc, pageNo, cssH, lazy, root, marks, hits, active, onDrawn }: {
  doc: PDFDocumentProxy; pageNo: number; cssH: number; lazy: boolean; root: React.RefObject<HTMLDivElement | null>;
  marks: number[][]; hits: number[][]; active: number[][]; onDrawn: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    void doc.getPage(pageNo).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setSize({ w: v.width, h: v.height });
    });
  }, [doc, pageNo]);
  useEffect(() => {
    if (!lazy) return setVisible(true);
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { root: root.current, rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, root]);
  const key = JSON.stringify([hits, active, marks]);
  useEffect(() => {
    const c = cv.current;
    if (!visible || !c || !size) return;
    let live = true;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const p = await doc.getPage(pageNo);
      if (!live) return;
      const s = cssH / size.h;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // Very large zooms are drawn at a capped resolution (the canvas is scaled by CSS).
      const k = Math.min(dpr, 5000 / (size.h * s));
      const vp = p.getViewport({ scale: s * k });
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      c.dataset.s = String(s);
      c.dataset.h = String(size.h);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      task = p.render({ canvas: c, canvasContext: ctx, viewport: vp });
      await task.promise;
      if (!live) return;
      const draw = (bs: number[][], fill: string, stroke: string) => {
        if (!bs.length) return;
        ctx.save();
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(1, k);
        for (const [x, y, w, h] of bs) {
          const [x1, y1] = vp.convertToViewportPoint(x - 1, y - h * 0.25);
          const [x2, y2] = vp.convertToViewportPoint(x + w + 1, y + h * 0.95);
          ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        }
        ctx.restore();
      };
      draw(marks, "rgba(255, 196, 0, 0.30)", "rgba(230, 120, 0, 0.8)");
      draw(hits, "rgba(255, 230, 0, 0.35)", "rgba(200, 160, 0, 0.6)");
      draw(active, "rgba(255, 120, 0, 0.45)", "rgba(220, 60, 0, 1)");
      onDrawn();
    })().catch(() => undefined);
    return () => {
      live = false;
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, size, cssH, key, doc, pageNo]);
  const w = size ? (cssH * size.w) / size.h : cssH / 1.294;
  return (
    <div ref={wrap} className="pdfv-page" data-page={pageNo} style={{ width: w, height: cssH }}>
      <canvas ref={cv} style={{ width: w, height: cssH }} aria-label={`Page ${pageNo}`} />
      <span className="pdfv-pno">{pageNo}</span>
    </div>
  );
}

// ───────── hover preview of a search result ─────────

let shiftDown = false;
const shiftSubs = new Set<() => void>();
const setShiftDown = (v: boolean) => {
  if (v === shiftDown) return;
  shiftDown = v;
  shiftSubs.forEach((f) => f());
};
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => e.key === "Shift" && setShiftDown(true), true);
  window.addEventListener("keyup", (e) => e.key === "Shift" && setShiftDown(false), true);
  window.addEventListener("blur", () => setShiftDown(false));
}
function useShiftHeld() {
  const [v, setV] = useState(shiftDown);
  useEffect(() => {
    const f = () => setV(shiftDown);
    shiftSubs.add(f);
    return () => void shiftSubs.delete(f);
  }, []);
  return v;
}
/** Hover state: opens after a short delay; closes when the mouse leaves the result and the popup (not while Shift is held). */
function useHitHover(shift: boolean) {
  const [at, setAt] = useState<{ hit: Hit; rect: DOMRect } | null>(null);
  const t = useRef(0);
  const over = useRef(false);
  const clear = () => window.clearTimeout(t.current);
  useEffect(() => {
    if (!shift && at && !over.current) {
      clear();
      t.current = window.setTimeout(() => !over.current && setAt(null), 160);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift]);
  useEffect(() => clear, []);
  return {
    at,
    enter: (hit: Hit, el: HTMLElement, anchor?: DOMRect) => {
      over.current = true;
      clear();
      // Pinned (Shift): the preview stays on its result until Shift is released.
      if (shiftDown && at) return;
      t.current = window.setTimeout(() => setAt({ hit, rect: anchor ?? el.getBoundingClientRect() }), at ? 60 : 350);
    },
    leave: () => {
      over.current = false;
      clear();
      if (shiftDown && at) return;
      t.current = window.setTimeout(() => setAt(null), 160);
    },
    keep: () => ((over.current = true), clear()),
    close: () => (clear(), setAt(null)),
  };
}
const HP_SIZE = "fpl.viewer.hitprev";
const HP_PCT = "fpl.viewer.hitprev.pct";
const HP_PCTS = [10, 20, 50, 70, 80, 90, 100];
/** The place of a result on its page: the page drawn large, scrolled so the result (highlighted) is in the middle. */
function HitPreview({ doc, hit, rect, pinned, onEnter, onLeave, onClose }: { doc: PDFDocumentProxy; hit: Hit; rect: DOMRect; pinned: boolean; onEnter: () => void; onLeave: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size] = useState<{ w: number; h: number }>(() => {
    try {
      return JSON.parse(localStorage.getItem(HP_SIZE) ?? "null") ?? { w: 520, h: 300 };
    } catch {
      return { w: 520, h: 300 };
    }
  });
  const geo = useRef<{ s: number; h: number } | null>(null);
  // Width shown (% of the page width across the preview): 100 % = the whole width, 10 % = a close-up. Kept in this browser.
  const [pct, setPctState] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(HP_PCT)) || 50;
    } catch {
      return 50;
    }
  });
  const setPct = (v: number) => {
    setPctState(v);
    try {
      localStorage.setItem(HP_PCT, String(v));
    } catch {
      /* ignore */
    }
  };
  const [areaW, setAreaW] = useState(0);
  const rz = useRef(0);
  const centre = () => {
    const a = area.current, g = geo.current, b = hit.boxes[0];
    if (!a || !g || !b) return;
    const [x, y, w, h] = b;
    a.scrollTo({ left: (x + w / 2) * g.s - a.clientWidth / 2, top: (g.h - y - h / 2) * g.s - a.clientHeight / 2 });
  };
  useEffect(() => {
    let live = true;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const p = await doc.getPage(hit.page);
      const c = cv.current;
      if (!live || !c) return;
      const base = p.getViewport({ scale: 1 });
      // The page about 2.4 × the preview width: the text reads at a comfortable size.
      // Zoom of this preview (its own, not the page view's): the share of the page width shown across the preview.
      const aw = area.current?.clientWidth || size.w;
      const s = Math.min(12, aw / (base.width * (pct / 100)));
      // Very large zooms are drawn at a capped resolution (largest side 8000 px).
      const dpr = Math.min(Math.min(2, window.devicePixelRatio || 1), 8000 / (Math.max(base.width, base.height) * s));
      const vp = p.getViewport({ scale: s * dpr });
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      c.style.width = `${base.width * s}px`;
      c.style.height = `${base.height * s}px`;
      geo.current = { s, h: base.height };
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      task = p.render({ canvas: c, canvasContext: ctx, viewport: vp });
      await task.promise;
      if (!live) return;
      ctx.fillStyle = "rgba(255, 120, 0, 0.35)";
      ctx.strokeStyle = "rgba(220, 60, 0, 1)";
      ctx.lineWidth = 2 * dpr;
      for (const [x, y, w, h] of hit.boxes) {
        const [x1, y1] = vp.convertToViewportPoint(x - 1, y - h * 0.25);
        const [x2, y2] = vp.convertToViewportPoint(x + w + 1, y + h * 0.95);
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      centre();
    })().catch(() => undefined);
    return () => {
      live = false;
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, hit, pct, areaW]);
  // Resizing (Shift held, corner grip): the size is kept in this browser and the result re-centred.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      try {
        localStorage.setItem(HP_SIZE, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
      } catch {
        /* ignore */
      }
      centre();
      // Width changed (resized): drawn again for the new width after a moment.
      window.clearTimeout(rz.current);
      rz.current = window.setTimeout(() => setAreaW((w) => (Math.abs((area.current?.clientWidth ?? 0) - w) > 4 ? area.current?.clientWidth ?? w : w)), 200);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const w = Math.min(size.w, window.innerWidth - 24), h = Math.min(size.h, window.innerHeight - 24);
  const left = Math.min(rect.right + 8, window.innerWidth - w - 12);
  const top = Math.max(12, Math.min(rect.top - 40, window.innerHeight - h - 12));
  return (
    <div ref={box} className={`pdfv-hitprev${pinned ? " pinned" : ""}`} style={{ left, top, width: w, height: h }} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog" aria-label={`Preview of the result on page ${hit.page}`}>
      <div className="pdfv-hitprev-h">
        <b>p. {hit.page}</b>
        <span className="ctx">{hit.before.slice(-30)}<mark>{hit.match}</mark>{hit.after.slice(0, 30)}</span>
        <span className="grow" />
        <span className="muted">{pinned ? "Shift held: drag the corner to resize" : "Hold Shift to keep open and resize"}</span>
      </div>
      <div className="pdfv-hitprev-z" role="group" aria-label="Width shown">
        <span className="muted">Width shown</span>
        {HP_PCTS.map((v) => <button key={v} type="button" className="bubble" aria-pressed={pct === v} onClick={() => setPct(v)} title={`${v} % of the page width across the preview`}>{v}%</button>)}
      </div>
      <div ref={area} className="pdfv-hitprev-a"><canvas ref={cv} /></div>
    </div>
  );
}
