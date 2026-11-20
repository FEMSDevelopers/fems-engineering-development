import { textQuery,
  BULK_FIELDS, MOUNT_TYPES, PART_FIELDS, bulkApply, multiSort, partColLabel, partColValue, partWatts, portSummary, specSummary, specText,
  type BomCtx, type BulkSet, type CustomFieldDef, type OutCol, type Part, type SortLevel, type SpecValue, type Subcategory,
} from "@fpl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type Preset } from "../api";
import { moveItem, useRowDrag } from "../dragRows";
import { Modal, useLocal, useUi } from "../ui";
import { ColumnsEditor } from "./OutColumns";
import { fmtN } from "./shared";

// ───────── columns of the master parts list ─────────

export const PARTS_BUILTIN: { key: string; label: string }[] = [
  { key: "sub", label: "Subcategory" },
  { key: "mfr", label: "Manufacturer" },
  { key: "pn", label: "Part number" },
  { key: "desc", label: "Description" },
  { key: "keyspecs", label: "Key specs" },
  { key: "power", label: "Power" },
  { key: "ports", label: "Ports" },
  { key: "mountSum", label: "Mount" },
  { key: "stockSum", label: "Stock" },
  { key: "docs", label: "Docs" },
  { key: "certs", label: "Certifications" },
];
export const PARTS_DEFAULT_COLS: OutCol[] = ["sub", "mfr", "pn", "desc", "keyspecs", "power", "ports", "mountSum", "stockSum", "docs"].map((key) => ({ key }));
export const PARTS_VIEW_SCOPE = "bom.parts-views";
export interface PartsView {
  cols: OutCol[];
  notes: string;
}

export function partsColLabel(c: OutCol, ctx?: BomCtx, fields?: Map<string, CustomFieldDef>): string {
  if (c.label) return c.label;
  const b = PARTS_BUILTIN.find((x) => x.key === c.key);
  if (b) return b.label;
  if (c.key.startsWith("spec:")) {
    const f = fields?.get(c.key.slice(5));
    if (f) return `${f.label}${f.unit ? ` (${f.unit})` : ""}`;
  }
  const l = partColLabel(c.key, ctx);
  return l.charAt(0) + l.slice(1).toLowerCase();
}
/** Text of a cell (shown, filtered on). */
export function partsCellText(key: string, p: Part, ctx: BomCtx, fields: Map<string, CustomFieldDef>): string {
  const sub = ctx.subcats?.get(p.subcategoryId ?? "");
  switch (key) {
    case "sub": return sub?.name ?? p.category ?? "";
    case "mfr": return p.manufacturer;
    case "pn": return p.partNumber;
    case "desc": return p.description;
    case "keyspecs": return sub ? specSummary(p, sub.fields) : "";
    case "power": {
      const w = partWatts(p);
      return [w != null ? `${fmtN(w)} W${p.powerIn?.kind ? ` ${p.powerIn.kind === "DC" ? "DC" : "AC"}` : ""}` : "", p.powerOut ? `→ ${fmtN(p.powerOut.watts ?? (p.powerOut.amps ?? 0) * (p.powerOut.voltage ?? 0))} W out` : ""].filter(Boolean).join(" · ");
    }
    case "ports": return portSummary(p);
    case "mountSum": return p.mech.rackUnits ? `${p.mech.rackUnits}U` : p.mech.dinWidthMm ? `DIN ${p.mech.dinWidthMm} mm` : p.mech.mount;
    case "stockSum": return [p.stock != null ? String(p.stock) : "", p.onOrder ? `+${p.onOrder}` : ""].filter(Boolean).join(" ");
    case "docs": return p.docCount ? String(p.docCount) : "";
    case "certs": return ((p.custom?.certs as string[]) ?? []).join(", ");
    default:
      if (key.startsWith("spec:")) {
        const f = (sub?.fields ?? []).find((x) => x.key === key.slice(5)) ?? fields.get(key.slice(5));
        return f ? specText(f, p.custom?.[f.key] as SpecValue) : String(p.custom?.[key.slice(5)] ?? "");
      }
      return partColValue(key, p, ctx);
  }
}
export function allSpecDefs(subcats: Subcategory[]): Map<string, CustomFieldDef> {
  const m = new Map<string, CustomFieldDef>();
  for (const s of subcats) for (const f of s.fields) if (!m.has(f.key)) m.set(f.key, f);
  return m;
}

// ───────── multi-level sort ─────────

export const PARTS_SORT_KEY = "fpl.bom.partsSort";
/** Value a column is sorted on: numbers stay numbers (price, stock, U, watts, numeric specs; a range sorts on its low end). */
export function partsSortValue(key: string, p: Part, ctx: BomCtx, fields: Map<string, CustomFieldDef>): string | number | null {
  switch (key) {
    case "power": return partWatts(p) ?? null;
    case "stockSum": return p.stock ?? null;
    case "docs": return p.docCount ?? 0;
    case "mountSum": return p.mech.rackUnits ? p.mech.rackUnits : p.mech.dinWidthMm ? 100 + p.mech.dinWidthMm : partsCellText(key, p, ctx, fields);
  }
  if (key.startsWith("spec:")) {
    const v = p.custom?.[key.slice(5)];
    if (typeof v === "number") return v;
    if (Array.isArray(v) && typeof v[0] === "number") return v[0];
    if (typeof v === "boolean") return v ? 1 : 0;
  }
  return partsCellText(key, p, ctx, fields);
}
export function sortParts(rows: Part[], levels: SortLevel[], ctx: BomCtx, fields: Map<string, CustomFieldDef>): Part[] {
  return multiSort(rows, levels, (k, p) => partsSortValue(k, p, ctx, fields));
}
const SORT_PRESETS: { label: string; sort: SortLevel[] }[] = [
  { label: "Catalog order (default)", sort: [] },
  { label: "Manufacturer › part number", sort: [{ key: "mfr" }, { key: "pn" }] },
  { label: "Subcategory › manufacturer › part number", sort: [{ key: "sub" }, { key: "mfr" }, { key: "pn" }] },
  { label: "Vendor › manufacturer › part number", sort: [{ key: "part:vendor" }, { key: "mfr" }, { key: "pn" }] },
  { label: "Part number A→Z", sort: [{ key: "pn" }] },
  { label: "Unit price high → low", sort: [{ key: "part:price", desc: true }, { key: "pn" }] },
  { label: "Stock low → high", sort: [{ key: "stockSum" }, { key: "pn" }] },
];
const dirLabel = (desc?: boolean) => (desc ? "Z→A / high→low" : "A→Z / low→high");
/** Short text of the sort, e.g. "Manufacturer ↑ › Part number ↑". */
export function sortSummary(levels: SortLevel[], label: (key: string) => string): string {
  return levels.map((l) => `${label(l.key)} ${l.desc ? "↓" : "↑"}`).join(" › ");
}

/** Multi-level sort rules of the master parts list: levels (column + direction), drag to reorder, presets, live preview. */
export function PartsSortModal({ levels, cols, ctx, fields, rows, onApply, onClose }: {
  levels: SortLevel[]; cols: OutCol[]; ctx: BomCtx; fields: Map<string, CustomFieldDef>; rows: Part[];
  onApply: (l: SortLevel[]) => void; onClose: () => void;
}) {
  const [d, setD] = useState<SortLevel[]>(levels);
  const drag = useRowDrag((a, b) => setD(moveItem(d, a, b)));
  const label = (key: string) => partsColLabel({ key }, ctx, fields);
  // Columns of the table first, then every other built-in / master-part / specification field.
  const choices = useMemo(() => {
    const seen = new Set<string>();
    const out: { key: string; label: string; group: string }[] = [];
    const add = (key: string, lbl: string, group: string) => !seen.has(key) && (seen.add(key), out.push({ key, label: lbl, group }));
    cols.forEach((c) => add(c.key, partsColLabel(c, ctx, fields), "Columns of this table"));
    PARTS_BUILTIN.forEach((b) => add(b.key, b.label, "Built-in"));
    PART_FIELDS.forEach((f) => add(`part:${f.key}`, f.label, `Master parts list · ${f.group}`));
    [...fields.values()].filter((f) => f.type !== "certs").forEach((f) => add(`spec:${f.key}`, `${f.label}${f.unit ? ` (${f.unit})` : ""}`, "Specifications"));
    return out;
  }, [cols, ctx, fields]);
  const groups = [...new Set(choices.map((c) => c.group))];
  const set = (i: number, l: Partial<SortLevel>) => setD(d.map((x, j) => (j === i ? { ...x, ...l } : x)));
  const prevCols = [...new Set(["pn", "mfr", ...d.map((l) => l.key)])].slice(0, 6);
  const preview = useMemo(() => sortParts(rows, d, ctx, fields).slice(0, 8), [rows, d, ctx, fields]);
  const used = new Set(d.map((l) => l.key));
  return (
    <Modal onClose={onClose} label="Sort the parts list">
      <div className="mh"><h3>Sort the parts list</h3><span className="muted" style={{ fontSize: 12.5 }}>Multi-level: ties on a level go to the next one. Numbers sort as numbers, text in natural order (A2 before A10); empty values always go last.</span></div>
      <div className="mb">
        <div className="frow tight" style={{ flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>Presets:</span>
          {SORT_PRESETS.map((p) => <button key={p.label} type="button" className="btn-ghost" onClick={() => setD(p.sort)}>{p.label}</button>)}
        </div>
        <fieldset className="sortbox">
          <legend>Sort levels</legend>
          <ol className="sortlv">
            {d.map((k, i) => (
              <li key={i} {...drag.row(i)}>
                <span {...drag.handle(i)}>⋮⋮</span>
                <span className="muted" style={{ minWidth: 34 }}>{i ? "then" : "by"}</span>
                <select aria-label={`Sort level ${i + 1}`} value={k.key} onChange={(e) => set(i, { key: e.target.value })} style={{ maxWidth: 320 }}>
                  {!choices.some((c) => c.key === k.key) && <option value={k.key}>{label(k.key)}</option>}
                  {groups.map((g) => (
                    <optgroup key={g} label={g}>
                      {choices.filter((c) => c.group === g).map((c) => <option key={c.key} value={c.key} disabled={c.key !== k.key && used.has(c.key)}>{c.label}</option>)}
                    </optgroup>
                  ))}
                </select>
                <div className="seg" role="group" aria-label={`Direction of level ${i + 1}`}>
                  <button type="button" aria-pressed={!k.desc} onClick={() => set(i, { desc: false })}>{dirLabel(false)}</button>
                  <button type="button" aria-pressed={!!k.desc} onClick={() => set(i, { desc: true })}>{dirLabel(true)}</button>
                </div>
                <button type="button" className="btn-ghost" aria-label={`Move level ${i + 1} up`} disabled={!i} onClick={() => setD(moveItem(d, i, i - 1))}>↑</button>
                <button type="button" className="btn-ghost" aria-label={`Move level ${i + 1} down`} disabled={i === d.length - 1} onClick={() => setD(moveItem(d, i, i + 1))}>↓</button>
                <button type="button" className="btn-ghost btn-danger" aria-label={`Remove level ${i + 1}`} onClick={() => setD(d.filter((_x, j) => j !== i))}>✕</button>
              </li>
            ))}
            {!d.length && <li className="muted" style={{ fontSize: 12.5 }}>No levels: catalog order (category › subcategory › manufacturer › part number).</li>}
            <li><button type="button" className="btn-ghost" onClick={() => setD([...d, { key: choices.find((c) => !used.has(c.key))?.key ?? "pn" }])}>+ Level</button></li>
          </ol>
        </fieldset>
        <h4 style={{ margin: 0 }}>Preview <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>first {preview.length} of {rows.length} parts in the current list</span></h4>
        <div className="colprev">
          <table className="net">
            <thead><tr><th>#</th>{prevCols.map((k) => <th key={k}>{label(k)}{d.findIndex((l) => l.key === k) >= 0 && <span className="sortmark"> {d.find((l) => l.key === k)!.desc ? "▼" : "▲"}{d.findIndex((l) => l.key === k) + 1}</span>}</th>)}</tr></thead>
            <tbody>{preview.map((p, i) => <tr key={p.id}><td className="muted">{i + 1}</td>{prevCols.map((k) => <td key={k}>{partsCellText(k, p, ctx, fields)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </div>
      <div className="mf">
        <button type="button" onClick={() => setD([])} disabled={!d.length}>Clear (catalog order)</button>
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => onApply(d)}>Apply</button>
      </div>
    </Modal>
  );
}

// ───────── views repository (no sub-versions) ─────────

/** Saved column views of the master parts list: new, rename, delete, notes, cancel changes, recently used. */
export function PartsViewsModal({ current, defaultCols, ctx, onUse, onClose }: {
  current: string; defaultCols: OutCol[]; ctx: BomCtx; onUse: (name: string, v: PartsView | null) => void; onClose: () => void;
}) {
  const ui = useUi();
  const [list, setList] = useState<Preset<PartsView>[]>([]);
  const [recent, setRecent] = useLocal<string[]>("fpl.bom.partsViewRecent", []);
  const [loaded, setLoaded] = useState<{ id: string | null; name: string; data: PartsView }>({ id: null, name: current, data: { cols: defaultCols, notes: "" } });
  const [d, setD] = useState<PartsView>(loaded.data);
  const dirty = JSON.stringify(d) !== JSON.stringify(loaded.data);
  const reload = async () => {
    const l = await api.presets.list<PartsView>(PARTS_VIEW_SCOPE).catch(() => [] as Preset<PartsView>[]);
    setList(l);
    return l;
  };
  useEffect(() => {
    reload().then((l) => {
      const p = l.find((x) => x.name === current);
      if (p) open(p, true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = async (p: Preset<PartsView> | null, force = false) => {
    if (!force && dirty && !(await ui.confirm("Discard the unsaved changes to this view?", "Discard"))) return;
    const data = p ? { cols: p.data.cols ?? [], notes: p.data.notes ?? "" } : { cols: PARTS_DEFAULT_COLS, notes: "" };
    setLoaded({ id: p?.id ?? null, name: p?.name ?? "", data });
    setD(data);
  };
  const save = async (name: string, data: PartsView) => {
    await api.presets.save(PARTS_VIEW_SCOPE, name, data);
    const l = await reload();
    const p = l.find((x) => x.name === name);
    if (p) setLoaded({ id: p.id, name, data });
    setRecent((r) => [name, ...r.filter((x) => x !== name)].slice(0, 8));
    return p;
  };
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const isDefault = !loaded.id;
  const ordered = [...list].sort((a, b) => {
    const ra = recent.indexOf(a.name);
    const rb = recent.indexOf(b.name);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.name.localeCompare(b.name);
  });
  return (
    <Modal onClose={onClose} label="Master parts list columns">
      <div className="mh viewbar">
        <h3>Columns of the master parts list</h3>
        <label className="ctl">View
          <select aria-label="Saved view" value={loaded.id ?? ""} onChange={(e) => open(list.find((x) => x.id === e.target.value) ?? null)}>
            <option value="">— per category / subcategory (no view) —</option>
            {recent.some((r) => list.some((x) => x.name === r)) && (
              <optgroup label="Recently used">
                {recent.map((r) => list.find((x) => x.name === r)).filter((x): x is Preset<PartsView> => !!x).map((x) => <option key={`r${x.id}`} value={x.id}>{x.name}</option>)}
              </optgroup>
            )}
            <optgroup label="All views">{ordered.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>
          </select>
        </label>
        <button type="button" onClick={() => act(async () => {
          const n = (await ui.prompt("Name of the new view", ""))?.trim();
          if (!n) return;
          if (list.some((x) => x.name === n)) return ui.toast(`A view named “${n}” exists already`);
          await save(n, d);
          ui.toast(`Saved the view “${n}”`);
        })} title="Save the columns below as a new view">New…</button>
        <button type="button" disabled={isDefault} onClick={() => act(async () => {
          const n = (await ui.prompt("Rename the view", loaded.name, "Rename"))?.trim();
          if (!n || n === loaded.name) return;
          if (list.some((x) => x.name === n)) return ui.toast(`A view named “${n}” exists already`);
          const old = loaded;
          await save(n, d);
          await api.presets.remove(old.id!);
          setRecent((r) => r.map((x) => (x === old.name ? n : x)));
          await reload();
        })}>Rename…</button>
        <button type="button" className="btn-danger" disabled={isDefault} onClick={() => act(async () => {
          if (!(await ui.confirm(`Delete the view “${loaded.name}”? It is shared with everyone using this database.`, "Delete"))) return;
          await api.presets.remove(loaded.id!);
          setRecent((r) => r.filter((x) => x !== loaded.name));
          await reload();
          open(null, true);
        })}>Delete</button>
        <button type="button" disabled={!dirty} onClick={() => setD(loaded.data)} title="Back to the saved columns and notes">Cancel changes</button>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>{isDefault ? "No view: the columns follow the category / subcategory (Columns…) — New… saves these as a view" : `${loaded.name}${dirty ? " · unsaved changes" : ""}`}</span>
      </div>
      <div className="mb">
        <ColumnsEditor cols={d.cols} setCols={(cols) => setD({ ...d, cols })} builtin={PARTS_BUILTIN} ctx={ctx} />
        <label className="f">Notes<textarea rows={2} value={d.notes} placeholder="What this view is for (e.g. purchasing review: vendor, price, stock)" onChange={(e) => setD({ ...d, notes: e.target.value })} /></label>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>A picked view shows the same columns for every category and subcategory. Without one, the columns follow the catalog selection (Columns…: All parts, each category, each subcategory — a subcategory compares its specifications side by side). Views are saved in the database (shared), without versions.</p>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Close</button>
        {!isDefault && <button type="button" disabled={!dirty} onClick={() => act(async () => (await save(loaded.name, d), ui.toast(`Saved “${loaded.name}”`)))}>Save</button>}
        <button type="button" className="btn-primary" onClick={() => act(async () => {
          if (!isDefault && dirty) await save(loaded.name, d);
          if (!isDefault) setRecent((r) => [loaded.name, ...r.filter((x) => x !== loaded.name)].slice(0, 8));
          onUse(isDefault ? "" : loaded.name, isDefault ? null : d);
          onClose();
        })}>{isDefault ? "Use per category / subcategory columns" : dirty ? "Save & use" : "Use this view"}</button>
      </div>
    </Modal>
  );
}

// ───────── column filter (click and hold a header) ─────────

export interface ColFilter {
  /** Values ticked (empty = every value). */
  vals: string[];
  /** Text the cell must contain (text query: | or, & and, * ? [] wildcards, =whole cell, !not, "literal"). */
  q: string;
  /** Text the cell must not contain (same syntax; e.g. `DS|DOC` = neither DS nor DOC). Both criteria must be met. */
  not?: string;
}
export const colFilterOn = (f?: ColFilter) => !!f && (f.vals.length > 0 || !!f.q.trim() || !!f.not?.trim());
/** Cell passes the text criteria (contains AND does not contain), not counting the ticked values. */
export function matchText(f: ColFilter, text: string): boolean {
  const inc = textQuery(f.q);
  if (inc && !inc(text)) return false;
  const exc = textQuery(f.not);
  return !(exc && exc(text));
}
export function matchFilter(f: ColFilter, text: string): boolean {
  if (!matchText(f, text)) return false;
  return !f.vals.length || f.vals.includes(text);
}
/** Short label of a filter for its chip. */
export const filterSummary = (f: ColFilter) =>
  [f.q.trim() && `“${f.q.trim()}”`, f.not?.trim() && `not “${f.not.trim()}”`, f.vals.length && `${f.vals.length} value(s)`].filter(Boolean).join(" + ");
const QUERY_HELP = "| or · & and (also OR / AND) · * any characters · ? one character · [abc] one of · =text whole cell (= alone: empty) · !text not · \"…\" literal";

/** Calls `onHold` after the pointer is held 300 ms on the element (a quick click does nothing). */
export function useHold(onHold: (el: HTMLElement) => void, ms = 300) {
  const t = useRef<number | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const cancel = () => {
    if (t.current) window.clearTimeout(t.current);
    t.current = null;
    setHolding(null);
  };
  const bind = (key: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      cancel();
      setHolding(key);
      t.current = window.setTimeout(() => (setHolding(null), (t.current = null), onHold(el)), ms);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  });
  return { bind, holding };
}

export function FilterPopover({ title, rect, values, f, onChange, onClose, sort }: {
  title: string; rect: DOMRect; values: [string, number][]; f: ColFilter; onChange: (f: ColFilter) => void; onClose: () => void;
  /** Sort of this column (optional): its direction, its level among the sort levels, and the change. */
  sort?: { dir: "asc" | "desc" | null; level: number; levels: number; onSort: (d: "asc" | "desc" | null) => void };
}) {
  const [q, setQ] = useState("");
  const shown = values.filter(([v]) => !q || v.toLowerCase().includes(q.toLowerCase()));
  const left = Math.min(rect.left, window.innerWidth - 330);
  return (
    <div className="popbg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="colfilter" role="dialog" aria-label={`Filter ${title}`} style={{ left, top: rect.bottom + 4 }}>
        <div className="cfh"><b>Filter: {title}</b><span className="grow" /><button type="button" className="btn-ghost" aria-label="Close" onClick={onClose}>✕</button></div>
        {sort && (
          <div className="cfsort" role="group" aria-label={`Sort ${title}`}>
            <span className="muted" style={{ fontSize: 12 }}>Sort{sort.dir && sort.levels > 1 ? ` (level ${sort.level})` : ""}</span>
            <button type="button" aria-pressed={sort.dir === "asc"} onClick={() => sort.onSort(sort.dir === "asc" ? null : "asc")}>▲ A→Z / low→high</button>
            <button type="button" aria-pressed={sort.dir === "desc"} onClick={() => sort.onSort(sort.dir === "desc" ? null : "desc")}>▼ Z→A / high→low</button>
            {sort.dir && <button type="button" className="btn-ghost" onClick={() => sort.onSort(null)}>No sort</button>}
          </div>
        )}
        <input type="search" aria-label="Contains" placeholder="Contains…  e.g. DS|DOC, AP75*" value={f.q} onChange={(e) => onChange({ ...f, q: e.target.value })} autoFocus title={QUERY_HELP} />
        <input type="search" aria-label="Does not contain" placeholder="Does not contain…  e.g. DS|DOC" value={f.not ?? ""} onChange={(e) => onChange({ ...f, not: e.target.value })} title={QUERY_HELP} />
        <div className="cfhelp muted" title={QUERY_HELP}>Both must be met. <code>|</code> or · <code>&amp;</code> and · <code>*</code> <code>?</code> <code>[ ]</code> wildcards · <code>=</code>whole cell · <code>!</code>not · <code>"…"</code> literal</div>
        <input type="search" aria-label="Find a value" placeholder={`Find among ${values.length} values`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="toolbar" style={{ gap: 4 }}>
          <button type="button" className="btn-ghost" onClick={() => onChange({ ...f, vals: [...new Set([...f.vals, ...shown.map(([v]) => v)])] })}>Tick shown</button>
          <button type="button" className="btn-ghost" onClick={() => onChange({ ...f, vals: f.vals.filter((v) => !shown.some(([s]) => s === v)) })}>Untick shown</button>
        </div>
        {(f.q.trim() || f.not?.trim()) && (() => {
          const pass = values.filter(([v]) => matchText(f, v));
          return <div className="cfhelp muted">{pass.reduce((a, [, n]) => a + n, 0)} row(s) meet the text criteria · {pass.length} of {values.length} values (others greyed)</div>;
        })()}
        <ul className="cfvals">
          {shown.slice(0, 400).map(([v, n]) => (
            <li key={v} className={matchText(f, v) ? undefined : "cfout"}>
              <label className="chk-l"><input type="checkbox" checked={f.vals.includes(v)} onChange={() => onChange({ ...f, vals: f.vals.includes(v) ? f.vals.filter((x) => x !== v) : [...f.vals, v] })} /> {v || <i className="muted">(empty)</i>} <span className="muted">{n}</span></label>
            </li>
          ))}
          {shown.length > 400 && <li className="muted">… {shown.length - 400} more (use Find)</li>}
        </ul>
        <div className="toolbar" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={() => onChange({ vals: [], q: "", not: "" })}>Clear filter</button>
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ───────── bulk update ─────────

const valOf = (p: Part, key: string): unknown => (key.startsWith("spec:") ? p.custom?.[key.slice(5)] : key.startsWith("mech.") ? (p.mech as unknown as Record<string, unknown>)[key.slice(5)] : (p as unknown as Record<string, unknown>)[key]);
const show = (v: unknown, subs: Map<string, Subcategory>, key: string) =>
  v == null || v === "" ? "—" : key === "subcategoryId" ? subs.get(String(v))?.name ?? String(v) : Array.isArray(v) ? v.join(v.length === 2 && typeof v[0] !== "string" ? "–" : ", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);

/** Bulk update of the parts in the current list (or the ticked parts): fields + values, overwrite or fill empty only. */
export function BulkUpdateModal({ listed, selected, subcats, onDone, onClose }: {
  listed: Part[]; selected: Part[]; subcats: Subcategory[]; onDone: (parts: Part[]) => void; onClose: () => void;
}) {
  const ui = useUi();
  const [useList, setUseList] = useState(true);
  const [sets, setSets] = useState<BulkSet[]>([{ key: "vendor", value: "" }]);
  const [mode, setMode] = useState<"overwrite" | "empty">("empty");
  const [busy, setBusy] = useState(false);
  const targets = useList ? listed : selected;
  const smap = useMemo(() => new Map(subcats.map((s) => [s.id, s])), [subcats]);
  // Specification fields: those of the target parts' subcategories first.
  const specs = useMemo(() => {
    const used = new Set(targets.map((p) => p.subcategoryId ?? ""));
    const m = new Map<string, CustomFieldDef & { mine: boolean }>();
    for (const s of subcats) for (const f of s.fields) {
      const mine = used.has(s.id);
      const cur = m.get(f.key);
      if (!cur || (mine && !cur.mine)) m.set(f.key, { ...f, mine });
    }
    return [...m.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || a.label.localeCompare(b.label));
  }, [subcats, targets]);
  const res = useMemo(() => targets.map((p) => ({ p, r: bulkApply(p, sets.filter((s) => s.key), mode, smap) })), [targets, sets, mode, smap]);
  const changing = res.filter((x) => x.r.patch);
  const errors = [...new Set(res.flatMap((x) => x.r.errors))];
  const skipped = res.reduce((n, x) => n + x.r.skipped.length, 0);
  const drag = useRowDrag((a, b) => setSets(moveItem(sets, a, b)));
  const labelOf = (k: string) => BULK_FIELDS.find((f) => f.key === k)?.label ?? specs.find((f) => `spec:${f.key}` === k)?.label ?? k;
  const input = (s: BulkSet, i: number) => {
    const set = (value: string) => setSets(sets.map((x, j) => (j === i ? { ...x, value } : x)));
    const f = BULK_FIELDS.find((x) => x.key === s.key);
    const sf = s.key.startsWith("spec:") ? specs.find((x) => x.key === s.key.slice(5)) : undefined;
    const aria = `Value of ${labelOf(s.key)}`;
    if (f?.kind === "status") return <select aria-label={aria} value={s.value} onChange={(e) => set(e.target.value)}><option value="active">Active</option><option value="spares">Spares only</option><option value="obsolete">Obsolete</option></select>;
    if (f?.kind === "mount") return <select aria-label={aria} value={s.value} onChange={(e) => set(e.target.value)}><option value="">(none)</option>{MOUNT_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
    if (f?.kind === "sub") return <select aria-label={aria} value={s.value} onChange={(e) => set(e.target.value)}><option value="">(none)</option>{subcats.map((x) => <option key={x.id} value={x.id}>{x.category} › {x.name}</option>)}</select>;
    if (f?.kind === "bool" || sf?.type === "bool") return <select aria-label={aria} value={s.value} onChange={(e) => set(e.target.value)}><option value="">(empty)</option><option value="yes">Yes</option><option value="no">No</option></select>;
    if (sf?.type === "select" && sf.options?.length)
      return <select aria-label={aria} value={s.value} onChange={(e) => set(e.target.value)}><option value="">(empty)</option>{sf.options.map((o) => <option key={o}>{o}</option>)}</select>;
    const ph = sf ? (sf.type === "range" ? "min-max, e.g. 100-240" : sf.type === "multi" || sf.type === "certs" ? `a, b${sf.options?.length ? ` (${sf.options.slice(0, 4).join(", ")}…)` : ""}` : sf.type === "number" ? `number${sf.unit ? ` (${sf.unit})` : ""}` : "text") : f?.kind === "number" ? "number" : "text";
    return <input type={f?.kind === "number" || sf?.type === "number" ? "text" : "text"} inputMode={f?.kind === "number" || sf?.type === "number" ? "decimal" : undefined} aria-label={aria} placeholder={ph} value={s.value} onChange={(e) => set(e.target.value)} style={{ width: "100%" }} />;
  };
  const apply = async () => {
    if (!changing.length) return;
    if (!(await ui.confirm(`Update ${changing.length} part(s) in the master parts list (${mode === "overwrite" ? "overwrite existing values" : "fill empty fields only"})?`, "Update"))) return;
    setBusy(true);
    try {
      const out: Part[] = [];
      const items = changing.map((x) => ({ id: x.p.id, patch: x.r.patch! }));
      for (let i = 0; i < items.length; i += 500) out.push(...(await api.parts.bulkUpdate(items.slice(i, i + 500))).parts);
      onDone(out);
      ui.toast(`Updated ${out.length} part(s)`);
      onClose();
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const groups = [...new Set(BULK_FIELDS.map((f) => f.group))];
  return (
    <Modal onClose={onClose} label="Bulk update parts">
      <div className="mh"><h3>Bulk update</h3><span className="muted" style={{ fontSize: 12.5 }}>{targets.length} part(s) of interest · {changing.length} will change</span></div>
      <div className="mb">
        <label className="chk-l"><input type="checkbox" checked={useList} onChange={(e) => setUseList(e.target.checked)} /> Use the current selection: every part listed with the current filters ({listed.length})</label>
        {!useList && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Ticked parts only: {selected.length}{selected.length ? "" : " — tick parts in the list first"}.</p>}
        <table className="mini wide bulktbl">
          <thead><tr><th aria-label="Move" /><th style={{ width: "36%" }}>Field</th><th>New value</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {sets.map((s, i) => (
              <tr key={i} {...drag.row(i)}>
                <td><span {...drag.handle(i)}>⋮⋮</span></td>
                <td>
                  <select aria-label={`Field ${i + 1}`} value={s.key} onChange={(e) => setSets(sets.map((x, j) => (j === i ? { key: e.target.value, value: e.target.value === "status" ? "active" : "" } : x)))} style={{ width: "100%" }}>
                    {groups.map((g) => <optgroup key={g} label={g}>{BULK_FIELDS.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key} disabled={sets.some((x, j) => j !== i && x.key === f.key)}>{f.label}</option>)}</optgroup>)}
                    <optgroup label="Specifications">{specs.map((f) => <option key={f.key} value={`spec:${f.key}`} disabled={sets.some((x, j) => j !== i && x.key === `spec:${f.key}`)}>{f.label}{f.unit ? ` (${f.unit})` : ""}{f.mine ? "" : " ·"}</option>)}</optgroup>
                  </select>
                </td>
                <td>{input(s, i)}</td>
                <td><button type="button" className="btn-ghost btn-danger" aria-label="Remove field" onClick={() => setSets(sets.filter((_x, j) => j !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="toolbar"><button type="button" onClick={() => setSets([...sets, { key: BULK_FIELDS.find((f) => !sets.some((s) => s.key === f.key))?.key ?? "", value: "" }])}>+ Field</button></div>
        <fieldset className="sortbox">
          <legend>Existing values</legend>
          <label className="chk-l"><input type="radio" name="bm" checked={mode === "empty"} onChange={() => setMode("empty")} /> Update empty fields only (keep existing values)</label>
          <label className="chk-l"><input type="radio" name="bm" checked={mode === "overwrite"} onChange={() => setMode("overwrite")} /> Overwrite existing values (an empty value clears the field)</label>
        </fieldset>
        {errors.length > 0 && <p className="errtxt" style={{ margin: 0 }}>{errors.join(" · ")}</p>}
        <h4 style={{ margin: 0 }}>Preview {skipped ? <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {skipped} existing value(s) kept</span> : null}</h4>
        <div className="colprev">
          <table className="mini wide">
            <thead><tr><th>Manufacturer</th><th>Part number</th><th>Field</th><th>Now</th><th>New</th></tr></thead>
            <tbody>
              {changing.slice(0, 80).flatMap(({ p, r }) => r.changed.map((k) => {
                const next = k.startsWith("spec:") ? (r.patch!.custom ?? {})[k.slice(5)] : k.startsWith("mech.") ? (r.patch!.mech as unknown as Record<string, unknown>)[k.slice(5)] : (r.patch as Record<string, unknown>)[k];
                return <tr key={p.id + k}><td>{p.manufacturer}</td><td className="mono">{p.partNumber}</td><td>{labelOf(k)}</td><td className="muted">{show(valOf(p, k), smap, k)}</td><td><b>{show(next, smap, k)}</b></td></tr>;
              }))}
              {!changing.length && <tr><td colSpan={5} className="muted">Nothing changes with these values.</td></tr>}
            </tbody>
          </table>
          {changing.length > 80 && <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>… and {changing.length - 80} more part(s)</p>}
        </div>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !changing.length || errors.length > 0} onClick={apply}>Update {changing.length} part(s)</button>
      </div>
    </Modal>
  );
}
