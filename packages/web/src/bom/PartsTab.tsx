import { emptyPart, nodeIdentity, walk, portSummary, specText, validateParts, type OutCol, type Part, type SortLevel, type SpecValue } from "@fpl/core";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { useLocal, useUi } from "../ui";
import { useColResize } from "../colResize";
import { MfrAliasModal } from "./aliases";
import { useBomDoc } from "./store";
import { SeriesDocsModal, PartEditor } from "./PartEditor";
import { PartImport } from "./PartImport";
import { type Catalog } from "./shared";
import { api as _api } from "../api";
import { filterSummary,
  BulkUpdateModal, FilterPopover, PARTS_SORT_KEY, PARTS_VIEW_SCOPE, PartsSortModal, PartsViewsModal, allSpecDefs, colFilterOn, matchFilter, partsCellText, partsColLabel, sortParts, sortSummary, useHold,
  type ColFilter, type PartsView,
} from "./partsCols";
import { SubcatEditor } from "./SubcatEditor";
import { DocScanModal } from "./DocScan";
import { CategoriesModal, TableTemplatesModal, resolveCols, scopeLabel, scopeOf, useTableTemplates } from "./catalogAdmin";

type Draft = Omit<Part, "id"> & { id?: string };

/** Master parts list: filter, short-list for the open project, edit, import, export. */
export function PartsTab({ cat, shortlist, setShortlist }: { cat: Catalog; shortlist: string[]; setShortlist: (ids: string[]) => void }) {
  const ui = useUi();
  const colRef = useColResize("bom.parts");
  const { parts, subcats, smap } = cat;
  const [pref, setPref] = useLocal<{ q: string; cat: string[]; sub: string; status: string; onlyShort: boolean }>("fpl.bom.parts", { q: "", cat: [], sub: "", status: "", onlyShort: false });
  const [editing, setEditing] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [subEdit, setSubEdit] = useState(false);
  const [catEdit, setCatEdit] = useState(false);
  const [tplDlg, setTplDlg] = useState(false);
  const tables = useTableTemplates(tplDlg);
  const [aliasEdit, setAliasEdit] = useState(false);
  const [bomDoc] = useBomDoc();
  const [sel, setSel] = useState<Set<string>>(new Set());
  // Column view (saved repository) and column filters (click and hold a header).
  const [viewName, setViewName] = useLocal<string>("fpl.bom.partsView", "");
  const [viewCols, setViewCols] = useLocal<PartsView | null>("fpl.bom.partsViewData", null);
  const [viewDlg, setViewDlg] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [recent] = useLocal<string[]>("fpl.bom.partsViewRecent", []);
  const [views, setViews] = useState<{ id: string; name: string; data: PartsView }[]>([]);
  useEffect(() => void _api.presets.list<PartsView>(PARTS_VIEW_SCOPE).then(setViews).catch(() => {}), [viewDlg]);
  const [colF, setColF] = useLocal<Record<string, ColFilter>>("fpl.bom.partsColF", {});
  const [filterAt, setFilterAt] = useState<{ key: string; rect: DOMRect } | null>(null);
  // Multi-level sort rules (empty = catalog order).
  const [sortLv, setSortLv] = useLocal<SortLevel[]>(PARTS_SORT_KEY, []);
  const [sortDlg, setSortDlg] = useState(false);
  const [scanDlg, setScanDlg] = useState(false);
  const [seriesDlg, setSeriesDlg] = useState<{ mfr: string; series: string } | null>(null);
  const hold = useHold((el) => {
    const key = el.dataset.col;
    if (key) setFilterAt({ key, rect: el.getBoundingClientRect() });
  });
  const fields = useMemo(() => allSpecDefs(subcats), [subcats]);
  const cats = useMemo(() => [...new Set([...subcats.map((s) => s.category), ...parts.map((p) => p.category)].filter(Boolean))], [subcats, parts]);
  const issues = useMemo(() => validateParts(parts), [parts]);
  const short = new Set(shortlist);
  const subOrder = useMemo(() => new Map(subcats.map((s, i) => [s.id, i])), [subcats]);

  const catRank = (c: string) => (c ? cats.indexOf(c) : 1e6);
  const base = useMemo(() => {
    const words = pref.q.toLowerCase().split(/\s+/).filter(Boolean);
    return parts
      .filter((p) => !pref.cat.length || pref.cat.includes(p.category || "(none)"))
      .filter((p) => !pref.sub || (pref.sub === "none" ? !p.subcategoryId : p.subcategoryId === pref.sub))
      .filter((p) => !pref.status || p.status === pref.status)
      .filter((p) => !pref.onlyShort || short.has(p.id))
      .filter((p) => {
        if (!words.length) return true;
        const hay = [p.manufacturer, p.partNumber, p.effPn && p.effPn !== p.partNumber ? p.effPn : "", p.sku ?? "", p.description, p.series, p.vendor, p.notes, p.category, smap.get(p.subcategoryId ?? "")?.name ?? ""].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => catRank(a.category) - catRank(b.category) || (subOrder.get(a.subcategoryId ?? "") ?? 1e9) - (subOrder.get(b.subcategoryId ?? "") ?? 1e9) || a.manufacturer.localeCompare(b.manufacturer) || a.partNumber.localeCompare(b.partNumber));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, pref, smap, cats, subOrder, shortlist]);
  const activeF = Object.entries(colF).filter(([, f]) => colFilterOn(f));
  const filtered = useMemo(() => (activeF.length ? base.filter((p) => activeF.every(([k, f]) => matchFilter(f, partsCellText(k, p, cat.ctx, fields)))) : base),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, colF, cat.ctx, fields]);
  const rows = useMemo(() => (sortLv.length ? sortParts(filtered, sortLv, cat.ctx, fields) : filtered), [filtered, sortLv, cat.ctx, fields]);
  const sortLabel = (key: string) => partsColLabel({ key }, cat.ctx, fields);

  const specSub = pref.sub && pref.sub !== "none" ? smap.get(pref.sub) : undefined;
  const specCols = (specSub?.fields ?? []).filter((f) => f.type !== "certs");
  const hasCerts = (specSub?.fields ?? []).some((f) => f.type === "certs");
  // A saved view (picked by name) replaces the columns of every catalog selection; without one the columns follow the
  // catalog selection (All parts / category / subcategory). An unnamed column override is no longer used.
  const custom = viewName ? views.find((v) => v.name === viewName)?.data ?? viewCols : null;
  useEffect(() => {
    if (!viewName && viewCols) setViewCols(null);
  }, [viewName, viewCols, setViewCols]);
  // Columns: a saved view when one is picked, else the table template of the catalog / subcatalog selection.
  const scope = scopeOf(pref.sub, pref.cat);
  const tpl = resolveCols(scope, tables, smap);
  const compare = !custom?.cols?.length && !!specSub && specCols.length > 0 && !tables.get(scope)?.cols.length;
  const cols: OutCol[] = custom?.cols?.length ? custom.cols : tpl.cols;
  const valuesOf = (key: string): [string, number][] => {
    const others = Object.entries(colF).filter(([k, f]) => k !== key && colFilterOn(f));
    const m = new Map<string, number>();
    for (const p of base) {
      if (!others.every(([k, f]) => matchFilter(f, partsCellText(k, p, cat.ctx, fields)))) continue;
      const t = partsCellText(key, p, cat.ctx, fields);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  };
  const toggleCat = (c: string | null) => setPref({ ...pref, cat: c == null ? [] : pref.cat.includes(c) ? pref.cat.filter((x) => x !== c) : [...pref.cat, c], sub: "" });
  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggleShort = (id: string) => setShortlist(short.has(id) ? shortlist.filter((x) => x !== id) : [...shortlist, id]);

  const exportXlsx = async () => {
    const head = ["CATEGORY", "SUBCATEGORY", "MANUFACTURER", "SERIES", "PART NUMBER", "DESCRIPTION", "TAG PREFIX", "VENDOR", "VENDOR CONTACT", "STATUS", "IN STOCK", "ON ORDER", "UNIT PRICE", "MOUNT", "U", "W mm", "H mm", "D mm", "DIN mm", "kg", "FEED", "FEED V", "FEED W", "FEED A", "FEED TERMINALS", "OUT", "OUT V", "OUT W", "OUT A", "EFF", "OUT TERMINALS", "PORTS", "NOTES"];
    const s = (v: unknown) => (v == null ? "" : String(v));
    const grid = [head, ...rows.map((p) => {
      const sub = smap.get(p.subcategoryId ?? "");
      return [p.category, sub?.name ?? "", p.manufacturer, p.series, p.partNumber, p.description, p.tagPrefix || sub?.tagPrefix || "", p.vendor, p.vendorContact, p.status, s(p.stock), s(p.onOrder), s(p.price),
        p.mech.mount, s(p.mech.rackUnits), s(p.mech.widthMm), s(p.mech.heightMm), s(p.mech.depthMm), s(p.mech.dinWidthMm), s(p.mech.weightKg),
        p.powerIn?.kind ?? "", s(p.powerIn?.voltage), s(p.powerIn?.watts), s(p.powerIn?.amps), p.powerIn?.terminals.join(", ") ?? "",
        p.powerOut?.kind ?? "", s(p.powerOut?.voltage), s(p.powerOut?.watts), s(p.powerOut?.amps), s(p.powerOut?.efficiency), p.powerOut?.terminals.join(", ") ?? "",
        portSummary(p), p.notes, ...specCols.map((f) => specText(f, p.custom?.[f.key] as SpecValue)), ...(hasCerts ? [((p.custom?.certs as string[]) ?? []).join(", ")] : [])];
    })];
    if (specCols.length) grid[0].push(...specCols.map((f) => `${f.label.toUpperCase()}${f.unit ? ` (${f.unit})` : ""}`), ...(hasCerts ? ["CERTIFICATIONS"] : []));
    try {
      await api.bomFiles.xlsx(specSub ? `parts-${specSub.name}` : "master-parts-list", [{ name: specSub ? specSub.name.slice(0, 31) : "Master parts", grid }]);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };

  const removeSel = async () => {
    const ids = [...sel];
    if (!ids.length || !(await ui.confirm(`Delete ${ids.length} part(s) from the master list? BOM lines that use them keep their saved manufacturer / part number / description.`, "Delete"))) return;
    try {
      await api.parts.removeMany(ids);
      setSel(new Set());
      await cat.refresh();
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };

  return (
    <section className="pane">
      <div className="toolbar sub">
        <input type="search" placeholder="Search manufacturer, part number, description…" value={pref.q} onChange={(e) => setPref({ ...pref, q: e.target.value })} style={{ width: 300 }} aria-label="Search parts" />
        <div className="bubbles" role="group" aria-label="Filter by category">
          <button type="button" className="bubble" aria-pressed={!pref.cat.length} onClick={() => toggleCat(null)}>All ({parts.length})</button>
          {cats.map((c) => <button key={c} type="button" className="bubble" aria-pressed={pref.cat.includes(c)} onClick={() => toggleCat(c)}>{c} <span className="muted">{parts.filter((p) => p.category === c).length}</span></button>)}
          {parts.some((p) => !p.category) && <button type="button" className="bubble" aria-pressed={pref.cat.includes("(none)")} onClick={() => toggleCat("(none)")}>Uncategorised</button>}
        </div>
        <select aria-label="Subcategory" value={pref.sub} onChange={(e) => setPref({ ...pref, sub: e.target.value })}>
          <option value="">All subcategories</option>
          {subcats.filter((s) => !pref.cat.length || pref.cat.includes(s.category)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="none">— none —</option>
        </select>
        <select aria-label="Status" value={pref.status} onChange={(e) => setPref({ ...pref, status: e.target.value })}>
          <option value="">Any status</option><option value="active">Active</option><option value="spares">Spares only</option><option value="obsolete">Obsolete</option>
        </select>
        <label className="chk-l"><input type="checkbox" checked={pref.onlyShort} onChange={(e) => setPref({ ...pref, onlyShort: e.target.checked })} /> Short-listed only ({shortlist.length})</label>
        <span className="grow" />
        <label className="ctl">View
          <select aria-label="Column view" value={viewName} onChange={(e) => {
            const n = e.target.value;
            setViewName(n);
            setViewCols(n ? views.find((v) => v.name === n)?.data ?? null : null);
          }} style={{ maxWidth: 180 }}>
            <option value="">Per category / subcategory</option>
            {recent.some((r) => views.some((v) => v.name === r)) && <optgroup label="Recently used">{recent.filter((r) => views.some((v) => v.name === r)).map((r) => <option key={`r${r}`} value={r}>{r}</option>)}</optgroup>}
            <optgroup label="All views">{views.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}</optgroup>
          </select>
        </label>
        <button type="button" className={`btn-ghost sorticon${sortLv.length ? " on" : ""}`} aria-label="Sort rules" onClick={() => setSortDlg(true)}
          title={sortLv.length ? `Sorted by ${sortSummary(sortLv, sortLabel)} — click to edit the sort levels` : "Sort: define multi-level sorting rules (catalog order now)"}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M6 3v13M6 16l-3-3M6 16l3-3M14 17V4M14 4l-3 3M14 4l3 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {sortLv.length > 0 && <span className="sortn">{sortLv.length}</span>}
        </button>
        <button type="button" className="btn-ghost gear" aria-label="Saved column views" title="Saved column views (new, rename, delete, notes): a picked view replaces the per-category / subcategory columns" onClick={() => setViewDlg(true)}>⚙️</button>
        <button type="button" onClick={() => setTplDlg(true)} title={`Columns per catalog selection — All parts, each category, each subcategory. Now shown: ${custom?.cols?.length ? `saved view “${viewName}”` : `${scopeLabel(tpl.from ?? scope, smap)} (${tpl.from ? "custom" : "built-in"})`}`}>Columns…</button>
        <button type="button" onClick={() => setBulk(true)} disabled={!parts.length} title="Set fields on many parts at once (current list or ticked parts)">Bulk update…</button>
        <button type="button" onClick={() => setCatEdit(true)} title="Categories with their subcategories: add, edit, delete">Categories…</button>
        <button type="button" onClick={() => setSubEdit(true)}>Subcategories…</button>
        <button type="button" onClick={() => {
          // Starts on the ticked part's (else the first listed part's) manufacturer and product series.
          const p = parts.find((x) => sel.has(x.id) && x.series) ?? rows.find((x) => x.series) ?? rows[0];
          setSeriesDlg({ mfr: p?.manufacturer ?? "", series: p?.series ?? "" });
        }} title="Product series per manufacturer: rename a series (every part of it follows) and its shared documents / certificates">Product series…</button>
        <button type="button" onClick={() => setAliasEdit(true)} title="Short hand per manufacturer: mfr_alias in Python rules, {mfra} in document names">Manufacturer aliases…</button>
        <button type="button" onClick={() => setImporting(true)}>Import…</button>
        <button type="button" onClick={exportXlsx} disabled={!rows.length}>Export .xlsx</button>
        <button type="button" className="btn-primary" onClick={() => setEditing(emptyPart(pref.sub && pref.sub !== "none" ? { subcategoryId: pref.sub, category: smap.get(pref.sub)?.category ?? "" } : {}))}>Add part</button>
        <button type="button" className="btn-ghost gear docscanbtn" aria-label="Scan folders for documents" onClick={() => setScanDlg(true)} disabled={!parts.length}
          title="Scan folders (and all sub-folders) for PDFs / manuals whose file name holds a part number: DS_ datasheet, IG_ installation guide, SS_ specification sheet, other prefixes → Other">🗃️</button>
      </div>
      {custom?.cols?.length ? (
        <div className="toolbar sub cmpbar">
          <span className="muted" style={{ fontSize: 12.5 }}>Saved view <b>{viewName}</b> replaces the columns of every category / subcategory.</span>
          <button type="button" className="btn-ghost" onClick={() => (setViewName(""), setViewCols(null))}>Back to per category / subcategory columns</button>
        </div>
      ) : null}
      {compare && (
        <div className="toolbar sub cmpbar">
          <span className="muted" style={{ fontSize: 12.5 }}>Comparing <b>{specSub!.name}</b> by its specifications ({specCols.length} criteria) across {new Set(rows.map((r) => r.manufacturer)).size} manufacturer(s). Pick “All subcategories” to return to the catalog columns.</span>
        </div>
      )}
      {activeF.length > 0 && (
        <div className="toolbar sub fbar">
          <span className="muted" style={{ fontSize: 12.5 }}>Column filters ({filtered.length} of {base.length}):</span>
          {activeF.map(([k, f]) => (
            <span key={k} className="chip info fchip">
              <button type="button" className="btn-ghost" onClick={(e) => setFilterAt({ key: k, rect: e.currentTarget.getBoundingClientRect() })}>{partsColLabel({ key: k }, cat.ctx, fields)}: {filterSummary(f)}</button>
              <button type="button" className="btn-ghost chipx" aria-label={`Clear filter ${k}`} onClick={() => setColF((c) => { const n = { ...c }; delete n[k]; return n; })}>✕</button>
            </span>
          ))}
          <button type="button" className="btn-ghost" onClick={() => setColF({})}>Clear all</button>
        </div>
      )}
      {sortLv.length > 0 && (
        <div className="toolbar sub fbar">
          <span className="muted" style={{ fontSize: 12.5 }}>Sorted by:</span>
          <span className="chip info fchip">
            <button type="button" className="btn-ghost" onClick={() => setSortDlg(true)}>{sortLv.map((l, i) => <span key={i}>{i ? " › " : ""}{sortLabel(l.key)} {l.desc ? "↓" : "↑"}</span>)}</button>
            <button type="button" className="btn-ghost chipx" aria-label="Clear sort" title="Back to catalog order" onClick={() => setSortLv([])}>✕</button>
          </span>
        </div>
      )}
      {custom?.notes && viewName && <div className="toolbar sub"><span className="muted" style={{ fontSize: 12 }}>View “{viewName}”: {custom.notes}</span></div>}
      {sel.size > 0 && (
        <div className="toolbar sub selbar">
          <b>{sel.size} selected</b>
          <button type="button" onClick={() => setShortlist([...new Set([...shortlist, ...sel])])}>☆ Add to project short-list</button>
          <button type="button" onClick={() => setShortlist(shortlist.filter((x) => !sel.has(x)))}>Remove from short-list</button>
          <button type="button" className="btn-danger" onClick={removeSel}>Delete…</button>
          <button type="button" className="btn-ghost" onClick={() => setSel(new Set())}>Clear selection</button>
        </div>
      )}
      <div className="scroll">
        {!parts.length && cat.loaded ? (
          <div className="empty-state">
            <h3>No parts yet</h3>
            <p>Import the master parts list (.xlsx), an equipment list from a drawing set, or add parts one by one.</p>
            <div className="toolbar"><button type="button" className="btn-primary" onClick={() => setImporting(true)}>Import…</button><button type="button" onClick={() => setEditing(emptyPart())}>Add part</button></div>
          </div>
        ) : (
          <table className="net parts" ref={colRef}>
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Select all" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                <th title="Project short-list">☆</th>
                {cols.map((c) => {
                  const on = colFilterOn(colF[c.key]);
                  const f = c.key.startsWith("spec:") ? fields.get(c.key.slice(5)) : undefined;
                  return (
                    <th key={c.key} data-col={c.key} {...hold.bind(c.key)} className={`hcol${hold.holding === c.key ? " holding" : ""}${on ? " filtered" : ""}${c.key.startsWith("spec:") ? " spech" : ""}`}
                      title={`${f?.help ? `${f.help}\n` : ""}Click and hold to filter this column`}>
                      {partsColLabel(c, cat.ctx, fields)}{on && <span className="funnel" aria-label="filtered"> ⏷</span>}
                      {(() => {
                        const li = sortLv.findIndex((l) => l.key === c.key);
                        return li < 0 ? null : <span className="sortmark" aria-label={`sorted ${sortLv[li].desc ? "descending" : "ascending"}, level ${li + 1}`}> {sortLv[li].desc ? "▼" : "▲"}{sortLv.length > 1 ? li + 1 : ""}</span>;
                      })()}
                    </th>
                  );
                })}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const is = issues[p.id] ?? [];
                return (
                  <tr key={p.id} className={p.status === "obsolete" ? "dim" : undefined} onDoubleClick={() => setEditing(p)} title={is.map((i) => i.msg).join("\n") || undefined}>
                    <td className="chk"><input type="checkbox" aria-label="Select" checked={sel.has(p.id)} onChange={() => setSel((s) => (s.has(p.id) ? (s.delete(p.id), new Set(s)) : new Set(s.add(p.id))))} /></td>
                    <td><button type="button" className={`star${short.has(p.id) ? " on" : ""}`} aria-pressed={short.has(p.id)} aria-label="Short-list for the project" onClick={() => toggleShort(p.id)}>{short.has(p.id) ? "★" : "☆"}</button></td>
                    {cols.map((c) => {
                      const t = partsCellText(c.key, p, cat.ctx, fields);
                      if (c.key === "pn") return <td key={c.key}><span className={`ro mono${is.some((i) => i.level === "error") ? " err" : ""}`}>{t}</span></td>;
                      if (c.key === "desc" || c.key === "keyspecs" || c.key === "part:oemDesc" || c.key === "part:notes") return <td key={c.key} className={`desc${compare || c.key !== "desc" ? " short" : ""}`}><span className="ro" title={t}>{t}</span></td>;
                      return <td key={c.key} className={c.key.startsWith("spec:") ? "specc" : undefined}><span className="ro" title={t.length > 30 ? t : undefined}>{t}</span></td>;
                    })}
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button type="button" className="btn-ghost" onClick={() => setEditing(p)}>Edit</button>
                      <button type="button" className="btn-ghost" title="Duplicate" aria-label="Duplicate" onClick={() => setEditing({ ...p, id: undefined, partNumber: `${p.partNumber}-COPY`, docCount: 0 })}>⧉</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {viewDlg && (
        <PartsViewsModal current={viewName} defaultCols={cols} ctx={cat.ctx} onClose={() => setViewDlg(false)}
          onUse={(n, v) => (setViewName(n), setViewCols(v))} />
      )}
      {seriesDlg && <SeriesDocsModal mfr={seriesDlg.mfr} series={seriesDlg.series} parts={parts} subcats={subcats} onPartsChanged={(ps) => ps.forEach((p) => cat.putPart(p))}
        onClose={() => (setSeriesDlg(null), cat.refresh())} />}
      {scanDlg && <DocScanModal listed={rows} selected={parts.filter((p) => sel.has(p.id))} onDone={cat.refresh} onClose={() => setScanDlg(false)} />}
      {sortDlg && (
        <PartsSortModal levels={sortLv} cols={cols} ctx={cat.ctx} fields={fields} rows={filtered}
          onApply={(l) => (setSortLv(l), setSortDlg(false))} onClose={() => setSortDlg(false)} />
      )}
      {filterAt && (
        <FilterPopover title={partsColLabel({ key: filterAt.key }, cat.ctx, fields)} rect={filterAt.rect} values={valuesOf(filterAt.key)} f={colF[filterAt.key] ?? { vals: [], q: "" }}
          onChange={(f) => setColF((c) => ({ ...c, [filterAt.key]: f }))} onClose={() => setFilterAt(null)} />
      )}
      {bulk && <BulkUpdateModal listed={rows} selected={parts.filter((p) => sel.has(p.id))} subcats={subcats} onClose={() => setBulk(false)} onDone={(ps) => ps.forEach(cat.putPart)} />}
      {aliasEdit && (
        <MfrAliasModal
          onClose={() => setAliasEdit(false)}
          bomMfrs={(() => {
            const m = new Set<string>();
            walk(bomDoc.units, (n) => n.kind === "part" && m.add(nodeIdentity(n, cat.ctx).manufacturer));
            return [...m].filter(Boolean);
          })()}
          allMfrs={parts.reduce((m, p) => m.set(p.manufacturer.trim(), (m.get(p.manufacturer.trim()) ?? 0) + 1), new Map<string, number>())}
        />
      )}
      {editing && <PartEditor part={editing} subcats={subcats} parts={cat.parts} onPartSaved={(p) => cat.putPart(p)} onSaved={(p) => cat.putPart(p)} onClose={() => (setEditing(null), cat.refresh())} />}
      {importing && <PartImport parts={parts} subcats={subcats} onDone={cat.refresh} onClose={() => setImporting(false)} />}
      {tplDlg && <TableTemplatesModal subcats={subcats} parts={parts} ctx={cat.ctx} current={scope} viewName={custom?.cols?.length ? viewName : ""}
        onClearView={() => (setViewName(""), setViewCols(null))} onClose={() => setTplDlg(false)} />}
      {catEdit && <CategoriesModal subcats={subcats} parts={parts} onChanged={cat.refresh} onClose={() => setCatEdit(false)} />}
      {subEdit && <SubcatEditor subcats={subcats} parts={parts} onChanged={cat.refresh} onClose={() => setSubEdit(false)} />}
    </section>
  );
}
