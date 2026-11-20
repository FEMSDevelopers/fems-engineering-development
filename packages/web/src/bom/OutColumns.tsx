import {
  DEFAULT_EQ_SPEC, DEFAULT_ROLLUP_SPEC, PART_FIELDS, ROLLUP_BUILTIN, partColLabel, specFields,
  type BomCtx, type EqListSpec, type Grid, type OutCol, type RollupSortKey, type RollupSpec,
} from "@fpl/core";
import { useMemo, useState } from "react";
import { Modal } from "../ui";
import { moveItem, useRowDrag } from "../dragRows";

/** Copy text to the clipboard (falls back to a hidden textarea when the async API is refused). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

type Choice = { key: string; label: string; group: string };
/** Every column that can be added: built-in columns, master parts list fields, specification fields. */
function useChoices(builtin: { key: string; label: string }[], ctx?: BomCtx): Choice[] {
  return useMemo(() => [
    ...builtin.map((b) => ({ ...b, group: "Built-in" })),
    ...PART_FIELDS.map((f) => ({ key: `part:${f.key}`, label: f.label, group: `Master parts list · ${f.group}` })),
    ...specFields(ctx).map((f) => ({ key: `spec:${f.key}`, label: f.label, group: "Master parts list · Specifications" })),
  ], [builtin, ctx]);
}
const labelOf = (choices: Choice[], c: OutCol, ctx?: BomCtx) => choices.find((x) => x.key === c.key)?.label ?? partColLabel(c.key, ctx);

/** Ordered column list (left; drag the ⋮⋮ handle or use ↑ ↓) + columns to add (right). */
export function ColumnsEditor({ cols, setCols, builtin, ctx, withSpecs = true }: { cols: OutCol[]; setCols: (c: OutCol[]) => void; builtin: { key: string; label: string }[]; ctx?: BomCtx; withSpecs?: boolean }) {
  const all = useChoices(builtin, ctx);
  const choices = withSpecs ? all : all.filter((c) => !c.key.startsWith("spec:"));
  const drag = useRowDrag((a, b) => setCols(moveItem(cols, a, b)));
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const avail = choices.filter((c) => !cols.some((x) => x.key === c.key) && (!ql || `${c.label} ${c.group}`.toLowerCase().includes(ql)));
  const groups = [...new Set(avail.map((a) => a.group))];
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    const n = cols.slice();
    [n[i], n[j]] = [n[j], n[i]];
    setCols(n);
  };
  return (
    <div className="colsed">
      <div className="colsel">
        <h4>Columns (in order) <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— drag ⋮⋮ to move</span></h4>
        <ol>
          {cols.map((c, i) => (
            <li key={c.key} {...drag.row(i)}>
              <span {...drag.handle(i)}>⋮⋮</span>
              <span className="mono k">{i + 1}</span>
              <span className="nm" title={c.key}>{labelOf(choices, c, ctx)}</span>
              <input type="text" aria-label={`Header of ${labelOf(choices, c, ctx)}`} placeholder="header (default)" value={c.label ?? ""} onChange={(e) => setCols(cols.map((x, k) => (k === i ? { ...x, label: e.target.value || undefined } : x)))} />
              <button type="button" className="btn-ghost" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="btn-ghost" aria-label="Move down" disabled={i === cols.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="btn-ghost btn-danger" aria-label={`Remove ${labelOf(choices, c, ctx)}`} onClick={() => setCols(cols.filter((_x, k) => k !== i))}>✕</button>
            </li>
          ))}
          {!cols.length && <li className="muted">No columns.</li>}
        </ol>
      </div>
      <div className="coladd">
        <h4>Add a column</h4>
        <input type="search" placeholder="Search fields (vendor, SKU, weight, poles…)" aria-label="Search columns" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="scroll">
          {groups.map((g) => (
            <div key={g}>
              <div className="cgrp">{g}</div>
              {avail.filter((a) => a.group === g).map((a) => (
                <button key={a.key} type="button" className="btn-ghost cadd" onClick={() => setCols([...cols, { key: a.key }])} title={a.key}>+ {a.label}</button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Preview({ grid, groupRows = [] }: { grid: Grid; groupRows?: number[] }) {
  const g = new Set(groupRows);
  return (
    <div className="colprev">
      <table className="mini wide">
        <thead><tr>{grid[0]?.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{grid.slice(1, 16).map((r, i) => <tr key={i} className={g.has(i + 1) ? "grp" : ""}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody>
      </table>
      {grid.length > 16 && <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>… {grid.length - 16} more rows</p>}
    </div>
  );
}

/** Equipment list content: columns (built-in + master parts list), headers, sub-header rows. */
export function EqListModal({ spec, builtin, ctx, preview, onApply, onClose }: {
  spec: EqListSpec; builtin: { key: string; label: string }[]; ctx?: BomCtx;
  preview: (s: EqListSpec) => { grid: Grid; groupRows: number[] } | null; onApply: (s: EqListSpec | null) => void; onClose: () => void;
}) {
  const [d, setD] = useState<EqListSpec>(spec);
  const pv = preview(d);
  return (
    <Modal onClose={onClose} label="Equipment list columns">
      <div className="mh"><h3>Equipment list content</h3><span className="muted" style={{ fontSize: 12.5 }}>Saved with the project BOM version; used by the .xlsx, the copies and “Everything”.</span></div>
      <div className="mb">
        <ColumnsEditor cols={d.cols} setCols={(cols) => setD({ ...d, cols })} builtin={builtin} ctx={ctx} />
        <label className="chk-l"><input type="checkbox" checked={d.groups !== false} onChange={(e) => setD({ ...d, groups: e.target.checked })} /> Include group / section rows (sub-headers)</label>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>TOTAL appears only on units with several instances (FNE × 17) unless you give it a header. Master-part columns are empty on group rows without a part number.</p>
        {pv && <><h4 style={{ margin: 0 }}>Preview (first unit)</h4><Preview grid={pv.grid} groupRows={pv.groupRows} /></>}
      </div>
      <div className="mf">
        <button type="button" onClick={() => setD(DEFAULT_EQ_SPEC)}>Reset to the drawing-set layout</button>
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => onApply(d)}>Apply</button>
      </div>
    </Modal>
  );
}

const PRESETS: { label: string; sort: RollupSortKey[] }[] = [
  { label: "Vendor › manufacturer › subcategory › part number", sort: [{ key: "vendor" }, { key: "mfr" }, { key: "sub" }, { key: "pn" }] },
  { label: "Part number A→Z", sort: [{ key: "pn" }] },
  { label: "Description A→Z", sort: [{ key: "desc" }] },
  { label: "Description Z→A", sort: [{ key: "desc", desc: true }] },
  { label: "Unit price high → low", sort: [{ key: "price", desc: true }, { key: "pn" }] },
  { label: "Extended price high → low", sort: [{ key: "ext", desc: true }, { key: "pn" }] },
  { label: "Quantity high → low", sort: [{ key: "total", desc: true }, { key: "pn" }] },
];

/** Purchasing roll-up: columns and sort (python sort order, or sort levels). */
export function RollupModal({ spec, ctx, preview, onApply, onClose }: {
  spec: RollupSpec; ctx?: BomCtx; preview: (s: RollupSpec) => Grid; onApply: (s: RollupSpec | null) => void; onClose: () => void;
}) {
  const [d, setD] = useState<RollupSpec>(spec);
  const choices = useChoices(ROLLUP_BUILTIN.filter((b) => b.key !== "units"), ctx);
  const setSort = (sort: RollupSortKey[]) => setD({ ...d, sort, sortMode: "keys" });
  const sdrag = useRowDrag((a, b) => setSort(moveItem(d.sort, a, b)));
  return (
    <Modal onClose={onClose} label="Purchasing roll-up columns and sort">
      <div className="mh"><h3>Purchasing roll-up — columns &amp; sort</h3><span className="muted" style={{ fontSize: 12.5 }}>Saved with the project BOM version.</span></div>
      <div className="mb">
        <ColumnsEditor cols={d.cols} setCols={(cols) => setD({ ...d, cols })} builtin={ROLLUP_BUILTIN} ctx={ctx} />
        <fieldset className="sortbox">
          <legend>Sort</legend>
          <label className="chk-l"><input type="radio" name="rsm" checked={d.sortMode === "python"} onChange={() => setD({ ...d, sortMode: "python" })} /> Outputs “Sort order” (Python key)</label>
          <label className="chk-l"><input type="radio" name="rsm" checked={d.sortMode === "keys"} onChange={() => setD({ ...d, sortMode: "keys" })} /> Sort levels</label>
          <div className="frow tight" style={{ flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>Presets:</span>
            {PRESETS.map((p) => <button key={p.label} type="button" className="btn-ghost" onClick={() => setSort(p.sort)}>{p.label}</button>)}
          </div>
          {d.sortMode === "keys" && (
            <ol className="sortlv">
              {d.sort.map((k, i) => (
                <li key={i} {...sdrag.row(i)}>
                  <span {...sdrag.handle(i)}>⋮⋮</span>
                  <span className="muted">{i ? "then" : "by"}</span>
                  <select aria-label={`Sort level ${i + 1}`} value={k.key} onChange={(e) => setSort(d.sort.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}>
                    {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                  <div className="seg" role="group" aria-label="Direction">
                    <button type="button" aria-pressed={!k.desc} onClick={() => setSort(d.sort.map((x, j) => (j === i ? { ...x, desc: false } : x)))}>A→Z / low→high</button>
                    <button type="button" aria-pressed={!!k.desc} onClick={() => setSort(d.sort.map((x, j) => (j === i ? { ...x, desc: true } : x)))}>Z→A / high→low</button>
                  </div>
                  <button type="button" className="btn-ghost btn-danger" aria-label="Remove level" onClick={() => setSort(d.sort.filter((_x, j) => j !== i))}>✕</button>
                </li>
              ))}
              <li><button type="button" className="btn-ghost" onClick={() => setSort([...d.sort, { key: "pn" }])}>+ Level</button></li>
            </ol>
          )}
        </fieldset>
        <h4 style={{ margin: 0 }}>Preview</h4>
        <Preview grid={preview(d)} />
      </div>
      <div className="mf">
        <button type="button" onClick={() => setD(DEFAULT_ROLLUP_SPEC)}>Reset</button>
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => onApply(d)}>Apply</button>
      </div>
    </Modal>
  );
}
