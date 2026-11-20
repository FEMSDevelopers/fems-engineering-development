import { SPEC_TEMPLATES, mergeSpecFields, type BomCtx, type OutCol, type Part, type Subcategory } from "@fpl/core";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg, type Preset } from "../api";
import { Modal, useLocal, useUi } from "../ui";
import { ColumnsEditor } from "./OutColumns";
import { PARTS_BUILTIN, PARTS_DEFAULT_COLS, partsColLabel, allSpecDefs } from "./partsCols";
import { ListIn, TextIn } from "./shared";
import { FieldDefs } from "./SubcatEditor";

// ───────── table templates: the columns rendered for a catalog / subcatalog selection ─────────

export const TABLE_SCOPE = "bom.parts-tables";
/** "*" = no catalog filter, "cat:<category>", "sub:<subcategory id>". */
export type TableKey = string;
export interface TableTemplate {
  cols: OutCol[];
}
/** Built-in columns of a scope: a subcategory with specifications compares them side by side. */
export function builtinCols(key: TableKey, smap: Map<string, Subcategory>): OutCol[] {
  if (key.startsWith("sub:")) {
    const s = smap.get(key.slice(4));
    const spec = (s?.fields ?? []).filter((f) => f.type !== "certs");
    if (spec.length)
      return [...PARTS_DEFAULT_COLS.slice(0, 4), ...spec.map((f) => ({ key: `spec:${f.key}` })), ...((s?.fields ?? []).some((f) => f.type === "certs") ? [{ key: "certs" }] : []), { key: "stockSum" }, { key: "docs" }];
  }
  return PARTS_DEFAULT_COLS;
}
/** Scope of the current filter: one subcategory, else one category, else everything. */
export function scopeOf(sub: string, cats: string[]): TableKey {
  if (sub && sub !== "none") return `sub:${sub}`;
  if (cats.length === 1 && cats[0] !== "(none)") return `cat:${cats[0]}`;
  return "*";
}
/** Columns for a scope: its saved template, else (category) the "*" template, else built-in. */
export function resolveCols(key: TableKey, saved: Map<string, TableTemplate>, smap: Map<string, Subcategory>): { cols: OutCol[]; from: TableKey | null } {
  const own = saved.get(key);
  if (own?.cols.length) return { cols: own.cols, from: key };
  if (key.startsWith("cat:") && saved.get("*")?.cols.length) return { cols: saved.get("*")!.cols, from: "*" };
  return { cols: builtinCols(key, smap), from: null };
}
export function useTableTemplates(reloadKey: unknown) {
  const [list, setList] = useState<Preset<TableTemplate>[]>([]);
  useEffect(() => void api.presets.list<TableTemplate>(TABLE_SCOPE).then(setList).catch(() => {}), [reloadKey]);
  return useMemo(() => new Map(list.map((p) => [p.name, p.data])), [list]);
}
export function scopeLabel(key: TableKey, smap: Map<string, Subcategory>): string {
  if (key === "*") return "All parts (no catalog filter)";
  if (key.startsWith("cat:")) return `${key.slice(4)} (category)`;
  const s = smap.get(key.slice(4));
  return s ? `${s.category} › ${s.name}` : "(deleted subcategory)";
}

/** ⚙️ Table templates: every catalog / subcatalog scope on the left, the column order of the selected one in the middle. */
export function TableTemplatesModal({ subcats, parts, ctx, current, viewName, onClearView, onClose }: {
  subcats: Subcategory[]; parts: Part[]; ctx: BomCtx; current: TableKey;
  /** Saved view in use (it replaces these columns until cleared). */
  viewName?: string; onClearView?: () => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const smap = useMemo(() => new Map(subcats.map((s) => [s.id, s])), [subcats]);
  const fields = useMemo(() => allSpecDefs(subcats), [subcats]);
  const [list, setList] = useState<Preset<TableTemplate>[]>([]);
  const reload = () => api.presets.list<TableTemplate>(TABLE_SCOPE).then(setList).catch((e) => ui.toast(errMsg(e)));
  useEffect(() => void reload(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = useMemo(() => new Map(list.map((p) => [p.name, p.data])), [list]);
  const [key, setKey] = useState<TableKey>(current);
  const base = resolveCols(key, saved, smap).cols;
  const [d, setD] = useState<OutCol[]>(base);
  const [q, setQ] = useState("");
  const [open, setOpen] = useLocal<string[]>("fpl.bom.tplcatsopen", []);
  useEffect(() => setD(resolveCols(key, saved, smap).cols), [key, saved, smap]);
  const dirty = JSON.stringify(d) !== JSON.stringify(base);
  const pick = async (k: TableKey) => {
    if (k === key) return;
    if (dirty && !(await ui.confirm("Discard the unsaved column changes of this table template?", "Discard"))) return;
    setKey(k);
  };
  const cats = [...new Set(subcats.map((s) => s.category))];
  const ql = q.trim().toLowerCase();
  const n = (k: TableKey) => (k === "*" ? parts.length : k.startsWith("cat:") ? parts.filter((p) => p.category === k.slice(4)).length : parts.filter((p) => p.subcategoryId === k.slice(4)).length);
  const Row = ({ k, label, depth }: { k: TableKey; label: string; depth: number }) => (
    <li className={`tplrow${k === key ? " sel" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => pick(k)}>
      <span className="nm">{label}</span>
      {saved.get(k)?.cols.length ? <span className="chip info" title="Custom columns">custom</span> : <span className="muted" style={{ fontSize: 11 }}>built-in</span>}
      <span className="muted" style={{ fontSize: 11, minWidth: 24, textAlign: "right" }}>{n(k)}</span>
    </li>
  );
  const own = saved.get(key);
  return (
    <Modal onClose={onClose} label="Table templates">
      <div className="mh"><h3>Columns — per category / subcategory</h3><span className="muted" style={{ fontSize: 12.5 }}>Pick a selection on the left and edit its columns. The table shows the columns of the current filter: a subcategory (built-in: its specifications side by side), else a category, else “All parts”. Shared in the database.</span></div>
      {viewName && (
        <div className="toolbar sub" style={{ padding: "4px 12px" }}>
          <span className="errtxt" style={{ fontSize: 12.5 }}>The saved view “{viewName}” is in use and replaces these columns.</span>
          <button type="button" onClick={onClearView}>Stop using the view</button>
        </div>
      )}
      <div className="mb ttgrid">
        <section className="ttleft tpllib">
          <input type="search" placeholder="Find a category / subcategory" aria-label="Find a table template" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="tlib">
            <Row k="*" label="All parts (no catalog filter)" depth={0} />
            {cats.map((c) => {
              const subs = subcats.filter((s) => s.category === c && (!ql || `${c} ${s.name}`.toLowerCase().includes(ql)));
              if (ql && !subs.length && !c.toLowerCase().includes(ql)) return null;
              const isOpen = open.includes(c) || !!ql || key.startsWith("sub:") && smap.get(key.slice(4))?.category === c;
              return (
                <li key={c} style={{ listStyle: "none" }}>
                  <div className="ttcat">
                    <button type="button" className="btn-ghost twisty" aria-label={isOpen ? `Collapse ${c}` : `Expand ${c}`} onClick={() => setOpen((o) => (o.includes(c) ? o.filter((x) => x !== c) : [...o, c]))}>{isOpen ? "▾" : "▸"}</button>
                    <ul className="tlib" style={{ flex: 1 }}><Row k={`cat:${c}`} label={c} depth={0} /></ul>
                  </div>
                  {isOpen && <ul className="tlib">{subs.map((s) => <Row key={s.id} k={`sub:${s.id}`} label={s.name} depth={2} />)}</ul>}
                </li>
              );
            })}
          </ul>
        </section>
        <section className="ttmid">
          <div className="toolbar" style={{ gap: 8 }}>
            <b>{scopeLabel(key, smap)}</b>
            <span className="muted" style={{ fontSize: 12 }}>{own?.cols.length ? "custom template" : key.startsWith("cat:") && saved.get("*")?.cols.length ? "uses “All parts”" : "built-in columns"}{dirty ? " · unsaved changes" : ""}</span>
            <span className="grow" />
            <button type="button" disabled={!dirty} onClick={() => setD(base)}>Cancel changes</button>
            <button type="button" disabled={!own} onClick={async () => {
              if (!own || !(await ui.confirm(`Delete the custom columns of ${scopeLabel(key, smap)} and use the built-in ones?`, "Reset"))) return;
              const p = list.find((x) => x.name === key);
              if (p) await api.presets.remove(p.id).catch((e) => ui.toast(errMsg(e)));
              await reload();
            }}>Reset to built-in</button>
            <button type="button" className="btn-primary" disabled={!dirty && !!own} onClick={async () => {
              try {
                await api.presets.save(TABLE_SCOPE, key, { cols: d });
                await reload();
                ui.toast(`Saved the columns of ${scopeLabel(key, smap)}`);
              } catch (e) {
                ui.toast(errMsg(e));
              }
            }}>Save</button>
          </div>
          <ColumnsEditor cols={d} setCols={setD} builtin={PARTS_BUILTIN} ctx={ctx} />
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Order: {d.map((c) => partsColLabel(c, ctx, fields)).join(" · ")}</p>
        </section>
      </div>
      <div className="mf"><button type="button" className="btn-primary" onClick={async () => {
        if (dirty && !(await ui.confirm("Close without saving the column changes?", "Close"))) return;
        onClose();
      }}>Done</button></div>
    </Modal>
  );
}

// ───────── categories & subcategories ─────────

/** Categories (left: every category with its subcategories) and the selected one's properties (right): add, edit, delete. */
export function CategoriesModal({ subcats, parts, onChanged, onClose }: { subcats: Subcategory[]; parts: Part[]; onChanged: () => Promise<void> | void; onClose: () => void }) {
  const ui = useUi();
  const [sel, setSel] = useState<{ cat: string; sub?: string } | null>(subcats[0] ? { cat: subcats[0].category } : null);
  const [open, setOpen] = useLocal<string[]>("fpl.bom.catsopen", []);
  const cats = [...new Set([...subcats.map((s) => s.category), ...parts.map((p) => p.category).filter(Boolean)])];
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await onChanged();
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const partsOf = (c: string) => parts.filter((p) => p.category === c);
  const usedSub = (id: string) => parts.filter((p) => p.subcategoryId === id).length;
  const sub = sel?.sub ? subcats.find((s) => s.id === sel.sub) : undefined;
  const addCategory = async () => {
    const c = (await ui.prompt("New category name", ""))?.trim();
    if (!c) return;
    if (cats.some((x) => x.toLowerCase() === c.toLowerCase())) return ui.toast(`“${c}” exists already`);
    const s = (await ui.prompt(`First subcategory of “${c}” (a category exists through its subcategories)`, ""))?.trim();
    if (!s) return;
    await run(async () => {
      const r = await api.subcats.create({ name: s, category: c });
      setOpen((o) => [...o, c]);
      setSel({ cat: c, sub: r.id });
    });
  };
  const addSub = async (c: string) => {
    const s = (await ui.prompt(`New subcategory in “${c}”`, ""))?.trim();
    if (!s) return;
    await run(async () => {
      const r = await api.subcats.create({ name: s, category: c });
      setOpen((o) => [...new Set([...o, c])]);
      setSel({ cat: c, sub: r.id });
    });
  };
  const renameCategory = async (c: string, to: string) => {
    const t = to.trim();
    if (!t || t === c) return;
    await run(async () => {
      for (const s of subcats.filter((x) => x.category === c)) await api.subcats.update(s.id, { category: t });
      const ps = partsOf(c);
      for (let i = 0; i < ps.length; i += 500) await api.parts.bulkUpdate(ps.slice(i, i + 500).map((p) => ({ id: p.id, patch: { category: t } })));
      setOpen((o) => o.map((x) => (x === c ? t : x)));
      setSel({ cat: t });
    });
  };
  const [moveTo, setMoveTo] = useState("");
  /** Delete a category: its subcategories and parts move to `to`, or (to = "") the subcategories are deleted and the parts become uncategorised. */
  const deleteCategory = async (c: string, to: string) => {
    const subs = subcats.filter((s) => s.category === c);
    const ps = partsOf(c);
    const what = to ? `${subs.length} subcategory(ies) and ${ps.length} part(s) move to “${to}”` : `${subs.length} subcategory(ies) are deleted and ${ps.length} part(s) become uncategorised`;
    if (!(await ui.confirm(`Delete the category “${c}”? ${what}.`, "Delete"))) return;
    await run(async () => {
      for (const s of subs) await (to ? api.subcats.update(s.id, { category: to }) : api.subcats.remove(s.id));
      for (let i = 0; i < ps.length; i += 500) await api.parts.bulkUpdate(ps.slice(i, i + 500).map((p) => ({ id: p.id, patch: { category: to } })));
      setSel(to ? { cat: to } : null);
      setMoveTo("");
    });
  };
  const move = (s: Subcategory, d: -1 | 1) => {
    const same = subcats.filter((x) => x.category === s.category);
    const i = same.findIndex((x) => x.id === s.id);
    const j = i + d;
    if (j < 0 || j >= same.length) return;
    const l = subcats.slice();
    const a = l.findIndex((x) => x.id === same[i].id);
    const b = l.findIndex((x) => x.id === same[j].id);
    [l[a], l[b]] = [l[b], l[a]];
    run(() => api.subcats.reorder(l.map((x) => x.id)));
  };
  return (
    <Modal onClose={onClose} label="Categories">
      <div className="mh"><h3>Categories &amp; subcategories</h3><span className="grow" /><button type="button" onClick={addCategory}>+ Category</button>{sel && <button type="button" onClick={() => addSub(sel.cat)}>+ Subcategory in {sel.cat}</button>}</div>
      <div className="mb ttgrid">
        <section className="ttleft tpllib">
          <ul className="tlib">
            {cats.map((c) => {
              const isOpen = open.includes(c);
              const subs = subcats.filter((s) => s.category === c);
              return (
                <li key={c} style={{ listStyle: "none" }}>
                  <div className={`fold${sel?.cat === c && !sel.sub ? " sel" : ""}`} onClick={() => setSel({ cat: c })}>
                    <button type="button" className="btn-ghost twisty" aria-label={isOpen ? `Collapse ${c}` : `Expand ${c}`} onClick={(e) => (e.stopPropagation(), setOpen((o) => (o.includes(c) ? o.filter((x) => x !== c) : [...o, c])))}>{isOpen ? "▾" : "▸"}</button>
                    <span className="ico">📁</span><b style={{ flex: 1 }}>{c}</b><span className="muted" style={{ fontSize: 11 }}>{subs.length} · {partsOf(c).length}</span>
                  </div>
                  {isOpen && (
                    <ul className="tlib">
                      {subs.map((s) => (
                        <li key={s.id} className={`tplrow${sel?.sub === s.id ? " sel" : ""}`} style={{ paddingLeft: 36 }} onClick={() => setSel({ cat: c, sub: s.id })}>
                          <span className="nm">{s.name}</span><span className="mono muted" style={{ fontSize: 11 }}>{s.tagPrefix}</span><span className="muted" style={{ fontSize: 11, minWidth: 22, textAlign: "right" }}>{usedSub(s.id) || ""}</span>
                        </li>
                      ))}
                      {!subs.length && <li className="muted" style={{ paddingLeft: 36, fontSize: 12 }}>no subcategories</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <section className="ttmid">
          {!sel ? <p className="muted">Pick a category or a subcategory on the left.</p> : !sub ? (
            <div className="inspf">
              <h4 style={{ margin: 0 }}>Category</h4>
              <label className="f">Name<TextIn key={sel.cat} label="Category name" value={sel.cat} onChange={(v) => renameCategory(sel.cat, v)} width={260} /></label>
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{subcats.filter((s) => s.category === sel.cat).length} subcategory(ies) · {partsOf(sel.cat).length} part(s). Renaming updates the subcategories and the parts.</p>
              <div className="toolbar"><button type="button" onClick={() => addSub(sel.cat)}>+ Subcategory</button></div>
              <div className="toolbar delcat">
                <label className="ctl">On delete, move its subcategories and parts to
                  <select aria-label="Move to category" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                    <option value="">— nowhere: delete the subcategories, parts uncategorised —</option>
                    {cats.filter((x) => x !== sel.cat).map((x) => <option key={x}>{x}</option>)}
                  </select>
                </label>
                <button type="button" className="btn-danger" onClick={() => deleteCategory(sel.cat, moveTo)}>Delete category</button>
              </div>
            </div>
          ) : (
            <div className="inspf">
              <h4 style={{ margin: 0 }}>Subcategory</h4>
              <div className="frow tight">
                <label className="f">Name<TextIn key={`n${sub.id}`} label="Subcategory name" value={sub.name} onChange={(v) => v.trim() && run(() => api.subcats.update(sub.id, { name: v.trim() }))} width={240} /></label>
                <label className="f">Category
                  <select aria-label="Category of the subcategory" value={sub.category} onChange={async (e) => {
                    let c = e.target.value;
                    if (c === "\u0000new") c = (await ui.prompt("New category name", ""))?.trim() ?? "";
                    if (c) run(async () => (await api.subcats.update(sub.id, { category: c }), setSel({ cat: c, sub: sub.id })));
                  }}>
                    {cats.map((c) => <option key={c}>{c}</option>)}
                    <option value={"\u0000new"}>New category…</option>
                  </select>
                </label>
                <label className="f">Tag prefix<TextIn key={`p${sub.id}`} label="Tag prefix" value={sub.tagPrefix} mono onChange={(v) => run(() => api.subcats.update(sub.id, { tagPrefix: v }))} width={100} /></label>
              </div>
              <label className="f">Port types<ListIn label="Port types" value={sub.portTypes} placeholder="e.g. IRIG-B, Relay out" onChange={(v) => run(() => api.subcats.update(sub.id, { portTypes: v }))} width={360} /></label>
              <div className="toolbar">
                <span className="muted" style={{ fontSize: 12.5 }}>{usedSub(sub.id)} part(s)</span>
                <button type="button" className="btn-ghost" onClick={() => move(sub, -1)}>↑ Move up</button>
                <button type="button" className="btn-ghost" onClick={() => move(sub, 1)}>↓ Move down</button>
                <span className="grow" />
                <button type="button" className="btn-danger" onClick={async () => {
                  const n = usedSub(sub.id);
                  if (!(await ui.confirm(`Delete the subcategory “${sub.name}”?${n ? ` ${n} part(s) keep their category but lose the subcategory.` : ""}`, "Delete"))) return;
                  await run(() => api.subcats.remove(sub.id));
                  setSel({ cat: sub.category });
                }}>Delete subcategory</button>
              </div>
              <div className="toolbar">
                <b style={{ fontSize: 13 }}>Specification fields ({sub.fields.length})</b>
                <span className="grow" />
                <select aria-label="Standard template" defaultValue="" onChange={(e) => {
                  const t = SPEC_TEMPLATES[e.target.value];
                  e.target.value = "";
                  if (t) run(() => api.subcats.update(sub.id, { fields: mergeSpecFields(sub.fields, t) }));
                }}>
                  <option value="">Add fields from a standard template…</option>
                  {Object.keys(SPEC_TEMPLATES).map((k) => <option key={k} value={k}>{k}{k === sub.name ? " (this subcategory)" : ""}</option>)}
                </select>
              </div>
              <FieldDefs key={sub.id} fields={sub.fields} onChange={(f) => run(() => api.subcats.update(sub.id, { fields: f }))} />
            </div>
          )}
        </section>
      </div>
      <div className="mf"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
