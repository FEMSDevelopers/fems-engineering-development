import type { Line, Rendered } from "@fpl/core";
import { useEffect, useRef } from "react";
import { LineView } from "../ui";

function scrollCenter(box: HTMLElement | null, el: HTMLElement | null) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  const top = e.top - b.top + box.scrollTop;
  const target = e.height > b.height - 20 ? top - 8 : top - (b.height - e.height) / 2;
  box.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

/** Table → JSON: one block per row; the selected block is highlighted and scrolled into view. */
export function JsonTable({ r, selected, onSelect, scrollKey }: { r: Rendered; selected: number; onSelect: (i: number) => void; scrollKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const sel = useRef<HTMLDivElement>(null);
  useEffect(() => scrollCenter(box.current, sel.current), [selected, scrollKey]);
  return (
    <div className="scroll" ref={box}>
      <pre className="json">
        <LineView line={r.open} className="wrap-line" />
        {r.items.map((it, i) => (
          <div
            key={i}
            ref={i === selected ? sel : undefined}
            className={`el${i === selected ? " sel" : ""}${it.duplicate ? " dup" : ""}`}
            onClick={() => !getSelection()?.toString() && onSelect(i)}
          >
            {it.lines.map((l, k) => <LineView key={k} line={l} />)}
          </div>
        ))}
        {r.items.length > 0 && <LineView line={r.close} className="wrap-line" />}
      </pre>
    </div>
  );
}

/** Column conditions: one row; lines map to columns. */
export function JsonRow({ lines, selCol, onSelectCol }: { lines: Line[]; selCol: number; onSelectCol: (j: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const sel = useRef<HTMLSpanElement>(null);
  useEffect(() => scrollCenter(box.current, sel.current), [selCol]);
  return (
    <div className="scroll" ref={box}>
      <pre className="json">
        {lines.map((l, i) =>
          l.col === undefined ? (
            <LineView key={i} line={l} className="wrap-line" />
          ) : (
            <LineView
              key={i}
              line={l}
              data-col={l.col}
              ref={l.col === selCol ? sel : undefined}
              className={l.col === selCol ? "csel" : undefined}
              onClick={() => !getSelection()?.toString() && onSelectCol(l.col!)}
            />
          ),
        )}
      </pre>
    </div>
  );
}
