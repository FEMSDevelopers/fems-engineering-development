import type { Connection } from "@fpl/core";
import { useEffect, useRef } from "react";
import { ColorPick } from "../ui";

/** Custom colours of a connection's row-number square. */
export interface NumColor {
  bg?: string;
  fg?: string;
}
export type NumColors = Record<string, NumColor>;

/** Connection ids in row order: the saved arrangement first, then any connection not yet in it. */
export function numberedIds(order: string[], drawable: Connection[]): string[] {
  const ids = new Set(drawable.map((c) => c.id));
  const saved = order.filter((id) => ids.has(id));
  const seen = new Set(saved);
  return [...saved, ...drawable.filter((c) => !seen.has(c.id)).map((c) => c.id)];
}

/** Square colours: custom ones, else the connection's line colour with white text. */
export const numStyle = (c: NumColor | undefined, lineColor: string) => ({ bg: c?.bg || lineColor, fg: c?.fg || "#ffffff" });

export const HOLD_NUM_MS = 200;

/**
 * Press-and-hold helper: calls `onHold` after `ms` unless the pointer moves or is released first.
 * Returns pointer handlers to spread on the element; `held()` tells a click handler to ignore the release.
 */
export function useHold(ms: number) {
  const t = useRef<{ timer: number; x: number; y: number } | null>(null);
  const fired = useRef(false);
  useEffect(() => () => {
    if (t.current) window.clearTimeout(t.current.timer);
  }, []);
  const cancel = () => {
    if (t.current) window.clearTimeout(t.current.timer);
    t.current = null;
  };
  return {
    start: (e: React.PointerEvent, onHold: (x: number, y: number) => void) => {
      cancel();
      fired.current = false;
      const { clientX: x, clientY: y } = e;
      t.current = { x, y, timer: window.setTimeout(() => ((fired.current = true), (t.current = null), onHold(x, y)), ms) };
    },
    move: (e: React.PointerEvent) => {
      if (t.current && Math.hypot(e.clientX - t.current.x, e.clientY - t.current.y) > 4) cancel();
    },
    end: cancel,
    /** True once if the last press turned into a hold (consumes the flag). */
    held: () => {
      const f = fired.current;
      fired.current = false;
      return f;
    },
  };
}

/** Small floating editor for one number square. Positioned in its container's coordinates. */
export function NumColorEditor({
  n, value, lineColor, x, y, onChange, onClose,
}: {
  n: number;
  value: NumColor | undefined;
  lineColor: string;
  x: number;
  y: number;
  onChange: (c: NumColor | null) => void;
  onClose: () => void;
}) {
  const st = numStyle(value, lineColor);
  return (
    <div className="nodeed numed" role="dialog" aria-label={`Colours of row ${n}`} style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="hd">
        <span className="sq" style={{ background: st.bg, color: st.fg }}>{n}</span>
        <b>Row {n} square</b>
        <button type="button" className="btn-ghost" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="row">
        <span>Square</span>
        <ColorPick label={`Square colour of row ${n}`} value={st.bg} onCommit={(bg) => onChange({ ...value, bg })} />
        <span>Text</span>
        <ColorPick label={`Text colour of row ${n}`} value={st.fg} onCommit={(fg) => onChange({ ...value, fg })} />
      </div>
      <div className="ft">
        <button type="button" className="btn-danger" disabled={!value?.bg && !value?.fg} onClick={() => onChange(null)}>Use line colour</button>
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
