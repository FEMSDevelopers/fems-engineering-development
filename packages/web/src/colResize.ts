/**
 * Resizable table columns: drag the right edge of a header cell. Widths are kept per table (`key`) and per header text,
 * in this browser. Double-click an edge to reset every column of the table to automatic widths.
 *
 * Works on any <table> whose header cells React renders freely: the grips are added to the DOM and re-added when the
 * header changes (MutationObserver). Once a column has been sized the table switches to `table-layout: fixed`, the other
 * columns keep the width they had, and cell text that no longer fits is cut with an ellipsis.
 */
import { useCallback, useEffect, useRef } from "react";

const PREFIX = "fpl.colw.";
const MIN = 28;

function load(key: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(PREFIX + key) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function save(key: string, w: Record<string, number>) {
  try {
    if (Object.keys(w).length) localStorage.setItem(PREFIX + key, JSON.stringify(w));
    else localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage unavailable: widths last for this page only */
  }
}

/** Header identity: its text (columns are configurable / reorderable), made unique by its occurrence. */
function headIds(ths: HTMLTableCellElement[]): string[] {
  const seen = new Map<string, number>();
  return ths.map((th, i) => {
    const t = (th.dataset.col || th.textContent || "").replace(/\s+/g, " ").trim() || `#${i}`;
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    return n > 1 ? `${t}~${n}` : t;
  });
}

export function useColResize(key: string) {
  const table = useRef<HTMLTableElement | null>(null);
  const widths = useRef<Record<string, number>>(load(key));
  const obs = useRef<MutationObserver | null>(null);

  const headerRow = () => table.current?.tHead?.rows[table.current.tHead.rows.length - 1] ?? null;

  const apply = useCallback(() => {
    const t = table.current;
    const row = headerRow();
    if (!t || !row) return;
    obs.current?.disconnect();
    const ths = [...row.cells] as HTMLTableCellElement[];
    const ids = headIds(ths);
    const w = widths.current;
    // Grips (one per header cell, the last one included).
    ths.forEach((th, i) => {
      let g = th.querySelector(":scope > .colgrip") as HTMLSpanElement | null;
      if (!g) {
        g = document.createElement("span");
        g.className = "colgrip";
        g.setAttribute("aria-hidden", "true");
        g.title = "Drag to resize · double-click to reset the column widths";
        th.appendChild(g);
        th.classList.add("rsz");
        if (getComputedStyle(th).position === "static") th.style.position = "relative";
      }
      g.dataset.i = String(i);
    });
    const any = ids.some((id) => w[id] != null);
    // Natural widths first (auto layout), then fix every column.
    t.style.tableLayout = "";
    t.style.width = "";
    ths.forEach((th) => (th.style.width = th.style.minWidth = th.style.maxWidth = ""));
    t.classList.toggle("colsized", any);
    if (any) {
      const nat = ths.map((th) => th.getBoundingClientRect().width);
      let sum = 0;
      ths.forEach((th, i) => {
        const v = Math.max(MIN, Math.round(w[ids[i]] ?? nat[i]));
        sum += v;
        th.style.width = th.style.minWidth = th.style.maxWidth = `${v}px`;
      });
      t.style.tableLayout = "fixed";
      t.style.width = `${sum}px`;
    }
    obs.current?.observe(t.tHead!, { childList: true, subtree: true, characterData: true });
  }, []);

  // Drag: pointer events on the grips (native, so header click-and-hold / sort handlers never see them).
  const onDown = useCallback((e: PointerEvent) => {
    const g = e.target as HTMLElement;
    if (!g.classList?.contains("colgrip") || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const row = headerRow();
    if (!row) return;
    const ths = [...row.cells] as HTMLTableCellElement[];
    const ids = headIds(ths);
    const i = Number(g.dataset.i);
    // Freeze every current width so only the dragged column changes.
    ths.forEach((th, k) => {
      if (widths.current[ids[k]] == null) widths.current[ids[k]] = Math.round(th.getBoundingClientRect().width);
    });
    const x0 = e.clientX;
    const w0 = widths.current[ids[i]];
    document.body.classList.add("colresizing");
    const move = (ev: PointerEvent) => {
      widths.current[ids[i]] = Math.max(MIN, Math.round(w0 + ev.clientX - x0));
      apply();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("colresizing");
      save(key, widths.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [apply, key]);
  const onDbl = useCallback((e: MouseEvent) => {
    if (!(e.target as HTMLElement).classList?.contains("colgrip")) return;
    e.preventDefault();
    e.stopPropagation();
    widths.current = {};
    save(key, {});
    apply();
  }, [apply, key]);
  // A click on a grip must not reach the header (sort, select…).
  const onClick = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).classList?.contains("colgrip")) e.stopPropagation();
  }, []);

  const ref = useCallback((el: HTMLTableElement | null) => {
    const prev = table.current;
    if (prev === el) return;
    if (prev) {
      prev.removeEventListener("pointerdown", onDown, true);
      prev.removeEventListener("dblclick", onDbl, true);
      prev.removeEventListener("click", onClick, true);
    }
    obs.current?.disconnect();
    table.current = el;
    if (!el) return;
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("dblclick", onDbl, true);
    el.addEventListener("click", onClick, true);
    obs.current = new MutationObserver(() => requestAnimationFrame(apply));
    apply();
  }, [apply, onDown, onDbl, onClick]);

  useEffect(() => () => obs.current?.disconnect(), []);
  return ref;
}
