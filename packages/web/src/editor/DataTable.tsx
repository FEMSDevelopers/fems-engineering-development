import { colName, dataRows, headerKeys, type ConditionState } from "@fpl/core";
import { useEffect, useRef, useState } from "react";

/** Cell editor used by both tables: Enter/blur commits, Escape cancels. */
export function CellInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (x: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(x);
  };
  return (
    <input
      autoFocus
      value={v}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        else if (e.key === "Escape") finish(null);
      }}
    />
  );
}

export function DataTable({
  st, selected, onSelect, onEdit, scrollRef,
}: {
  st: ConditionState;
  selected: number;
  onSelect: (i: number) => void;
  onEdit: (r: number, c: number, v: string) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const rows = dataRows(st);
  const w = st.grid[0]?.length ?? 0;
  const keys = headerKeys(st);
  const off = st.opts.hdr ? 1 : 0;
  const keyed = st.opts.shape === "keyed";
  const selRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const tr = selRef.current;
    const box = scrollRef.current;
    if (!tr || !box) return;
    const b = box.getBoundingClientRect();
    const e = tr.getBoundingClientRect();
    const head = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    if (e.top < b.top + head || e.bottom > b.bottom) box.scrollTo({ top: box.scrollTop + e.top - b.top - head - (b.height - head - e.height) / 2, behavior: "smooth" });
  }, [selected, scrollRef]);

  const cell = (r: number, c: number, v: string, th = false) => {
    const isEd = editing?.r === r && editing?.c === c;
    const Tag = th ? "th" : "td";
    if (isEd)
      return (
        <Tag key={c} className="editing">
          <CellInput
            value={v}
            onDone={(nv) => {
              setEditing(null);
              if (nv !== null && nv !== v) onEdit(r, c, nv);
            }}
          />
        </Tag>
      );
    return (
      <Tag
        key={c}
        className={!th && v === "" ? "empty" : undefined}
        title={th ? "Double-click to rename" : undefined}
        onDoubleClick={() => (r >= 0 ? setEditing({ r, c }) : undefined)}
      >
        {th ? (
          <>
            <span>{v || " "}</span>
            {keys[c] !== v && st.opts.shape !== "arrays" && !(keyed && c === 0) && <span className="k">{keys[c]}</span>}
          </>
        ) : (
          v
        )}
      </Tag>
    );
  };

  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="idx" title="JSON index">#</th>
          {Array.from({ length: w }, (_, j) => cell(st.opts.hdr ? 0 : -1, j, st.opts.hdr ? st.grid[0][j] ?? "" : colName(j), true))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} ref={i === selected ? selRef : undefined} className={i === selected ? "sel" : undefined} onClick={() => !editing && onSelect(i)}>
            <td className="idx">{keyed ? "" : i}</td>
            {Array.from({ length: w }, (_, j) => cell(i + off, j, r[j] ?? ""))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
