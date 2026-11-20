import { useRef, useState } from "react";
import { Popover, useLocal } from "../ui";
import { HOLD_NUM_MS, NumColorEditor, numStyle, useHold, type NumColor, type NumColors } from "./numbering";

export interface SummaryRow {
  id: string;
  /** Row number (1-based, follows the saved arrangement). */
  n: number;
  color: string;
  /** Drawn in the diagram right now (not hidden by filters). */
  shown: boolean;
  from: EndInfo;
  to: EndInfo;
  protocol: string;
  svcPort: string;
  address: string;
  hops: number;
  pathText: string;
}
export interface EndInfo {
  device: string;
  port: string;
  vlan: string;
  ip: string;
  service: string;
}

type Get = (r: SummaryRow) => string | number;
export const SUMMARY_COLS: { key: string; group: "from" | "conn" | "between" | "to"; label: string; get: Get; mono?: boolean }[] = [
  { key: "from.device", group: "from", label: "Device", get: (r) => r.from.device },
  { key: "from.port", group: "from", label: "Port", get: (r) => r.from.port, mono: true },
  { key: "from.vlan", group: "from", label: "VLAN", get: (r) => r.from.vlan, mono: true },
  { key: "from.ip", group: "from", label: "IP", get: (r) => r.from.ip, mono: true },
  { key: "from.service", group: "from", label: "Service", get: (r) => r.from.service },
  { key: "conn.protocol", group: "conn", label: "Protocol", get: (r) => r.protocol },
  { key: "conn.svcPort", group: "conn", label: "Svc port", get: (r) => r.svcPort, mono: true },
  { key: "conn.address", group: "conn", label: "Address", get: (r) => r.address, mono: true },
  { key: "between.hops", group: "between", label: "Hops", get: (r) => r.hops },
  { key: "to.device", group: "to", label: "Device", get: (r) => r.to.device },
  { key: "to.port", group: "to", label: "Port", get: (r) => r.to.port, mono: true },
  { key: "to.vlan", group: "to", label: "VLAN", get: (r) => r.to.vlan, mono: true },
  { key: "to.ip", group: "to", label: "IP", get: (r) => r.to.ip, mono: true },
  { key: "to.service", group: "to", label: "Service", get: (r) => r.to.service },
];
export const DEFAULT_SUMMARY_COLS = SUMMARY_COLS.filter((c) => !["from.service", "to.service", "conn.address"].includes(c.key)).map((c) => c.key);
const GROUP_LABEL = { from: "From (client)", conn: "Connection", between: "In between", to: "To (server)" } as const;

/** Numbered summary of the diagram's connections, with column choice and arrangement (drag or type a row number). */
export function SummaryPanel({
  rows, cols, onCols, onMove, selected, related, onSelect, numbers, onNumbers, onClose, numColors, onNumColor,
}: {
  numColors: NumColors;
  onNumColor: (id: string, c: NumColor | null) => void;
  rows: SummaryRow[];
  cols: string[];
  onCols: (cols: string[]) => void;
  /** Move a connection to a 0-based position. */
  onMove: (id: string, to: number) => void;
  selected: string | null;
  /** Rows to highlight (e.g. connections of the selected device). */
  related: Set<string>;
  onSelect: (id: string) => void;
  numbers: boolean;
  onNumbers: (v: boolean) => void;
  onClose: () => void;
}) {
  const [arrange, setArrange] = useState(false);
  const hold = useHold(HOLD_NUM_MS);
  const asideRef = useRef<HTMLElement>(null);
  const [numEdit, setNumEdit] = useState<{ id: string; x: number; y: number } | null>(null);
  // Width is a per-viewer preference; drag the left edge to resize.
  const [width, setWidth] = useLocal<number>("fpl.diagram.summaryWidth", 520);
  const rs = useRef<{ x: number; w: number } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const visible = SUMMARY_COLS.filter((c) => cols.includes(c.key));
  const groups = (["from", "conn", "between", "to"] as const).map((g) => ({ g, n: visible.filter((c) => c.group === g).length })).filter((x) => x.n);
  const toggleCol = (k: string) => onCols(cols.includes(k) ? cols.filter((x) => x !== k) : SUMMARY_COLS.map((c) => c.key).filter((x) => x === k || cols.includes(x)));

  return (
    <aside className="dg-summary" aria-label="Connection summary" style={{ width }} ref={asideRef}>
      {numEdit && rows.some((r) => r.id === numEdit.id) && (() => {
        const r = rows.find((x) => x.id === numEdit.id)!;
        return (
          <NumColorEditor
            n={r.n}
            value={numColors[r.id]}
            lineColor={r.color}
            x={Math.max(8, Math.min(numEdit.x, width - 270))}
            y={numEdit.y + 10}
            onChange={(c) => onNumColor(r.id, c)}
            onClose={() => setNumEdit(null)}
          />
        );
      })()}
      <div
        className="rsz"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize summary"
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          rs.current = { x: e.clientX, w: width };
        }}
        onPointerMove={(e) => rs.current && setWidth(Math.min(1100, Math.max(280, rs.current.w + rs.current.x - e.clientX)))}
        onPointerUp={() => (rs.current = null)}
      />
      <div className="sh">
        <b>Summary</b>
        <span className="muted">{rows.length} connection{rows.length === 1 ? "" : "s"}</span>
        <span className="grow" />
        <Popover label="Summary columns" align="right" button={<>Columns…</>}>
          {() => (
            <div className="sum-cols">
              {(["from", "conn", "between", "to"] as const).map((g) => (
                <div key={g}>
                  <h5>{GROUP_LABEL[g]}</h5>
                  {SUMMARY_COLS.filter((c) => c.group === g).map((c) => (
                    <label key={c.key} className="ctl">
                      <input type="checkbox" checked={cols.includes(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}
                    </label>
                  ))}
                </div>
              ))}
              <div className="full">
                <label className="ctl"><input type="checkbox" checked={numbers} onChange={(e) => onNumbers(e.target.checked)} /> Show row numbers on the diagram lines</label>
                <button type="button" className="btn-ghost" onClick={() => onCols(SUMMARY_COLS.map((c) => c.key))}>Show all</button>
                <button type="button" className="btn-ghost" onClick={() => onCols(DEFAULT_SUMMARY_COLS)}>Default</button>
              </div>
            </div>
          )}
        </Popover>
        <button type="button" className={arrange ? "btn-primary" : undefined} aria-pressed={arrange} onClick={() => setArrange(!arrange)} title="Reorder connections: drag rows or type a row number">
          {arrange ? "Done" : "Arrange…"}
        </button>
        <button type="button" className="btn-ghost" aria-label="Hide summary" onClick={onClose}>✕</button>
      </div>
      {arrange && <div className="hint">Drag ⋮⋮ or type a new row number and press Enter. The order is saved with the diagram version.</div>}
      <div className="sb">
        {!rows.length ? (
          <p className="muted" style={{ padding: 12 }}>No connections to summarise yet.</p>
        ) : (
          <table className="sumt">
            <thead>
              <tr className="g">
                <th rowSpan={2} className="num">#</th>
                {groups.map(({ g, n }) => <th key={g} colSpan={n} className={`grp-${g}`}>{GROUP_LABEL[g]}</th>)}
              </tr>
              <tr>
                {visible.map((c) => <th key={c.key} className={`grp-${c.group}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={[selected === r.id && "sel", related.has(r.id) && "rel", !r.shown && "hid", over === r.id && "over"].filter(Boolean).join(" ") || undefined}
                  title={r.shown ? undefined : "Not drawn: hidden by the current filters"}
                  onClick={() => !arrange && !hold.held() && onSelect(r.id)}
                  draggable={arrange}
                  onDragStart={(e) => {
                    setDrag(r.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (drag && drag !== r.id) {
                      e.preventDefault();
                      setOver(r.id);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag) onMove(drag, r.n - 1);
                    setDrag(null);
                    setOver(null);
                  }}
                >
                  <td className="num">
                    {arrange ? (
                      <span className="arr">
                        <span className="grip" aria-hidden="true">⋮⋮</span>
                        <input
                          type="number"
                          min={1}
                          max={rows.length}
                          aria-label={`Row number for connection ${r.n}`}
                          defaultValue={r.n}
                          key={r.n}
                          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                          onBlur={(e) => {
                            const v = Math.round(Number(e.target.value));
                            if (v && v !== r.n) onMove(r.id, Math.min(rows.length, Math.max(1, v)) - 1);
                            else e.target.value = String(r.n);
                          }}
                        />
                      </span>
                    ) : (
                      (() => {
                        const st = numStyle(numColors[r.id], r.color);
                        return (
                          <span
                            className="sq"
                            style={{ background: st.bg, color: st.fg }}
                            title="Click and hold to change this square's colours"
                            onPointerDown={(e) =>
                              hold.start(e, (x, y) => {
                                const box = asideRef.current?.getBoundingClientRect();
                                if (box) setNumEdit({ id: r.id, x: x - box.left, y: y - box.top });
                              })
                            }
                            onPointerMove={hold.move}
                            onPointerUp={hold.end}
                            onPointerLeave={hold.end}
                          >
                            {r.n}
                          </span>
                        );
                      })()
                    )}
                  </td>
                  {visible.map((c) => {
                    const v = c.get(r);
                    return (
                      <td key={c.key} className={[`grp-${c.group}`, c.mono && "mono"].filter(Boolean).join(" ")} title={c.key === "between.hops" ? r.pathText : undefined}>
                        {v === "" ? <span className="muted">—</span> : v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}
