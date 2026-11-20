import { DEFAULT_EQ_SPEC, DEFAULT_ROLLUP_SPEC, EQ_BUILTIN, eqCopyRows, equipmentLists, itemsByPart, rollupGridSpec, sortRollup, toTsv, DEFAULT_DOC_ORDER, DEFAULT_SORT, explode, latest, pnFormatter, pnScope, runPy, sortRows, verLabel, computeLoads, loadGrid, refreshSnaps, rollup, tagListGrid, unitLabelOf, type BomDoc } from "@fpl/core";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg, type XlsxSheet } from "../api";
import { Modal, useUi } from "../ui";
import { useColResize } from "../colResize";
import { NamingPicker, NamingStandardsModal, defaultNamingValue, namingFromValue, NamingRules, resolveNaming, useDocKinds, useEditPartStandard, useNamingStandards } from "./Naming";
import { ImportPnFormat, PnRulesModal, pyFormat } from "./PnFormat";
import { useMfrAliases } from "./aliases";
import { PROJ_KEY, libId } from "./mechPlaced";
import { PyEditor, type Entry } from "./PyEditor";
import { useSortDraft } from "./store";
import { stableJson } from "../snapshots";
import { VersionBar } from "../VersionBar";
import { fmtN, type Catalog } from "./shared";
import { EqListModal, RollupModal, copyText } from "./OutColumns";

/** Generated outputs of the open project BOM: equipment lists, purchasing roll-up, tag list, load schedules, document package. */
export function OutputsTab({ cat, doc, setDoc }: { cat: Catalog; doc: BomDoc; setDoc: (d: BomDoc) => void }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const rollColRef = useColResize("bom.rollup");
  const [kinds, setKinds] = useState<string[]>([]);
  const [withAsm, setWithAsm] = useState(false);
  const [namingDlg, setNamingDlg] = useState<"import" | "edit" | null>(null);
  const [pnDlg, setPnDlg] = useState<"import" | "edit" | null>(null);
  const subs = Object.fromEntries(cat.parts.map((p) => [p.id, cat.smap.get(p.subcategoryId ?? "")?.name ?? ""]));
  const aliases = useMfrAliases();
  // File names in the package: the Edit-part "Standard name" (or the project's own copy of a standard) — never the uploaded names.
  const editStd = useEditPartStandard();
  // Document-type bubbles: every type defined in the naming standards, the project's copy included.
  const docKinds = useDocKinds([...(doc.naming?.std.rules.map((r) => r.kind) ?? []), ...editStd.std.rules.map((r) => r.kind)]);
  const eqCtx = useMemo(() => {
    const pn = pnFormatter(doc.pnFormat ? pyFormat(doc.pnFormat.fmt) : null, (p) => cat.smap.get(p.subcategoryId ?? "")?.name ?? "", { aliases });
    return pn ? { ...cat.ctx, pn } : cat.ctx;
  }, [doc.pnFormat, cat.ctx, cat.smap, aliases]);
  const units = useMemo(() => refreshSnaps(doc.units, cat.ctx), [doc.units, cat.ctx]);
  const [sortFmt, setSortFmt] = useSortDraft();
  const [sortKey, setSortKey] = useState(0);
  // Part lines (BOM item numbers), units and device tags per master part — from the open BOM or its latest saved version.
  const dx = { before: "", after: "", source: "open" as const, unitSheets: false, byLine: false, docOrder: DEFAULT_DOC_ORDER, ...(doc.docExport ?? {}) };
  const setDx = (patch: Partial<typeof dx>) => setDoc({ ...doc, docExport: { ...dx, ...patch } });
  const [linked, setLinked] = useState<{ units: typeof doc.units; label: string } | null>(null);
  useEffect(() => {
    if (dx.source !== "latest") return setLinked(null);
    const id = libId(PROJ_KEY);
    if (!id) return setLinked(null);
    let live = true;
    (async () => {
      try {
        const p = await api.bomProjects.get(id);
        const v = latest(p.versions);
        if (!v) return;
        const r = await api.bomProjects.getVersion(id, v.major, v.minor);
        if (live) setLinked({ units: refreshSnaps((r.data as BomDoc).units, cat.ctx), label: `${p.name} v${verLabel(v)}${(r.data as BomDoc).stage ? ` (${(r.data as BomDoc).stage})` : ""}` });
      } catch {
        if (live) setLinked(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [dx.source, cat.ctx]);
  const lineUnits = dx.source === "latest" && linked ? linked.units : units;
  const partLines = useMemo(() => {
    const m = new Map<string, { items: string[]; units: string[]; tags: string[]; byUnit: Map<string, string[]>; lines: { item: string; unit: string; tags: string[] }[] }>();
    for (const l of explode(lineUnits, cat.ctx)) {
      if (!l.partId || l.kind !== "part") continue;
      const e = m.get(l.partId) ?? { items: [] as string[], units: [] as string[], tags: [] as string[], byUnit: new Map<string, string[]>(), lines: [] as { item: string; unit: string; tags: string[] }[] };
      e.lines.push({ item: l.itemNo, unit: l.unit, tags: l.fullTags });
      if (l.itemNo && !e.items.includes(l.itemNo)) e.items.push(l.itemNo);
      if (!e.units.includes(l.unit)) e.units.push(l.unit);
      e.tags.push(...l.fullTags);
      e.byUnit.set(l.unitId, [...(e.byUnit.get(l.unitId) ?? []), l.itemNo].filter(Boolean));
      m.set(l.partId, e);
    }
    return m;
  }, [lineUnits, cat.ctx]);
  /** Names of the export prefix / suffix code; `line` narrows item / unit / tags to one part line (folder per part line). */
  const wrapScope = (partId: string, line?: { item: string; unit: string; tags: string[] }) => {
    const p = cat.pmap.get(partId);
    const e = partLines.get(partId);
    const base = p ? pnScope(p, cat.smap.get(p.subcategoryId ?? "")?.name ?? "", { aliases }) : {};
    return {
      ...base, item: line?.item ?? e?.items[0] ?? "", items: e?.items ?? [], unit: line?.unit ?? e?.units[0] ?? "", units: e?.units ?? [], tags: line?.tags ?? e?.tags ?? [],
      project: doc.project.name, number: doc.project.number, client: doc.project.client, stage: doc.stage,
    };
  };
  const evalWrap = (src: string, partId: string, line?: { item: string; unit: string; tags: string[] }): { text: string; error?: string } => {
    if (!src.trim()) return { text: "" };
    try {
      return { text: runPy(src, wrapScope(partId, line)).replace(/\s+/g, " ").trim() };
    } catch (e) {
      return { text: "", error: (e as Error).message };
    }
  };
  const rows0 = useMemo(() => rollup(units, cat.ctx, { withAssemblies: withAsm }), [units, cat.ctx, withAsm]);
  const sorted = useMemo(
    () => sortRows(rows0, sortFmt, (r) => {
      const p = r.partId ? cat.pmap.get(r.partId) : undefined;
      const e = r.partId ? partLines.get(r.partId) : undefined;
      return { part: p, sub: p ? cat.smap.get(p.subcategoryId ?? "")?.name ?? "" : "", partNumber: r.partNumber, manufacturer: r.manufacturer, items: e?.items ?? [], units: e?.units ?? [], total: r.total };
    }, { aliases }),
    [rows0, sortFmt, cat.pmap, cat.smap, partLines, aliases],
  );
  const rows = sorted.rows;
  // Purchasing roll-up: chosen columns and sort (Python sort order, or sort levels).
  const rspec = doc.rollupSpec ?? DEFAULT_ROLLUP_SPEC;
  const items = useMemo(() => itemsByPart(units), [units]);
  const sortedBy = (sp: typeof rspec) => (sp.sortMode === "keys" && sp.sort.length ? sortRollup(rows0, sp.sort, cat.ctx, { items }) : rows);
  const rollRows = sortedBy(rspec);
  const eqSpec = doc.eqList ?? DEFAULT_EQ_SPEC;
  const [colDlg, setColDlg] = useState<"eq" | "roll" | null>(null);
  const [eqUnit, setEqUnit] = useState("");
  const unitLabels = units.map(unitLabelOf);
  const name = doc.project.name || "project";
  const partIds = [...new Set(rows.map((r) => r.partId).filter((x): x is string => !!x))];
  const docParts = partIds.filter((id) => (cat.pmap.get(id)?.docCount ?? 0) > 0).length;
  const noPower = rows.filter((r) => r.partId && !cat.pmap.get(r.partId)?.powerIn && !cat.pmap.get(r.partId)?.powerOut).length;

  /** Field-panel tab of the documentation package names: part line, units, tags and project data of a part. */
  const wrapTab = (partId?: string): Entry[] => {
    const sc = partId ? (wrapScope(partId) as Record<string, unknown>) : {};
    return [
      { token: "item", label: "first BOM part line (item no.)", value: sc.item },
      { token: '"+".join(items)', label: "every part line of this part", value: Array.isArray(sc.items) ? (sc.items as string[]).join("+") : "" },
      { token: "unit", label: "first unit (RACK.01, FNE…)", value: sc.unit },
      { token: '"+".join(units)', label: "every unit", value: Array.isArray(sc.units) ? (sc.units as string[]).join("+") : "" },
      { token: "tags[0] if tags else \"\"", label: "first full device tag", value: Array.isArray(sc.tags) ? (sc.tags as string[])[0] : "" },
      { token: "project", label: "project name", value: sc.project },
      { token: "number", label: "project number", value: sc.number },
      { token: "client", label: "client", value: sc.client },
      { token: "stage", label: "stage", value: sc.stage },
    ];
  };
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const eqSheets = (): XlsxSheet[] => equipmentLists(units, eqCtx, eqSpec).map((g) => ({ name: g.name, title: g.title, grid: g.grid, groupRows: g.groupRows }));
  const rollSheet = (): XlsxSheet => ({ name: "Purchasing", title: `${name} — ${doc.stage} — purchasing roll-up`, grid: rollupGridSpec(rollRows, unitLabels, rspec, cat.ctx, { items }) });
  const copyEq = async (mode: "body" | "full") => {
    const gs = equipmentLists(units, eqCtx, eqSpec);
    const g = gs[Math.max(0, units.findIndex((u) => u.id === eqUnit))];
    if (!g) return;
    const rowsOut = eqCopyRows(g, mode);
    await copyText(toTsv(rowsOut));
    ui.toast(`Copied ${rowsOut.length} row(s) of ${g.name} — paste into Excel or a drawing table`);
  };
  const tagSheet = (): XlsxSheet => ({ name: "Device tags", grid: tagListGrid(units, eqCtx) });
  const loadSheet = (): XlsxSheet | null => {
    if (!doc.loads?.length) return null;
    const res = computeLoads(doc.loads, units, cat.ctx);
    const grid: string[][] = [];
    const groupRows: number[] = [];
    for (const b of doc.loads) {
      const r = res.get(b.id);
      if (!r) continue;
      groupRows.push(grid.length, grid.length + 2);
      grid.push(...loadGrid(b, r), ["", ""]);
    }
    return { name: "Load schedule", grid, groupRows };
  };

  return (
    <section className="pane">
      <div className="scroll">
        <div className="outgrid">
          <div className="card">
            <h3>Equipment lists</h3>
            <p className="muted">One sheet per unit in the drawing-set layout (No., manufacturer, part number, description, qty, prefix, total, device tags).</p>
            <div className="namingbox">
              <span className="muted">Part numbers:</span>{" "}
              {doc.pnFormat ? <b>{doc.pnFormat.from ? `${doc.pnFormat.from.name} v${doc.pnFormat.from.major}.${String(doc.pnFormat.from.minor).padStart(3, "0")} (project copy)` : "project format"}</b> : <span>as in the master parts list</span>}
              <div className="toolbar">
                <button type="button" className="btn-ghost" onClick={() => setPnDlg("import")}>Import PN format…</button>
                <button type="button" className="btn-ghost" disabled={!doc.pnFormat} onClick={() => setPnDlg("edit")}>Edit format…</button>
                {doc.pnFormat && <button type="button" className="btn-ghost" onClick={() => setDoc({ ...doc, pnFormat: null })}>Use master part numbers</button>}
              </div>
            </div>
            <div className="toolbar">
              <button type="button" onClick={() => setColDlg("eq")} title="Columns of the file (built-in and master parts list fields), headers, sub-header rows">Columns…</button>
              <span className="muted" style={{ fontSize: 12 }}>{eqSpec.cols.length} columns{doc.eqList ? " (custom)" : ""}</span>
            </div>
            <button type="button" className="btn-primary" disabled={busy || !units.length} onClick={() => run(() => api.bomFiles.xlsx(`${name} ${doc.stage} equipment lists`, eqSheets()))}>Download .xlsx</button>
            <div className="toolbar copybar">
              <label className="ctl">Copy unit
                <select aria-label="Unit to copy" value={eqUnit || units[0]?.id || ""} onChange={(e) => setEqUnit(e.target.value)}>
                  {units.map((u) => <option key={u.id} value={u.id}>{unitLabelOf(u)}</option>)}
                </select>
              </label>
              <button type="button" disabled={!units.length} onClick={() => copyEq("body")} title="Every row of the table (sub-headers included), without the column-name header row">Copy table (no header)</button>
              <button type="button" disabled={!units.length} onClick={() => copyEq("full")} title="The column-name header row plus only the rows with full content; sub-header rows without a part number are left out">Copy header + content</button>
            </div>
          </div>
          <div className="card">
            <h3>Purchasing roll-up</h3>
            <p className="muted">Totals per manufacturer + part number across every unit and instance, with stock, on-order and to-buy.</p>
            <label className="chk-l"><input type="checkbox" checked={withAsm} onChange={(e) => setWithAsm(e.target.checked)} /> Include in-house assembly lines with a part number</label>
            <div className="toolbar">
              <button type="button" onClick={() => setColDlg("roll")} title="Columns (vendor, manufacturer, subcategory, part number, master part fields…) and sort">Columns &amp; sort…</button>
              <span className="muted" style={{ fontSize: 12 }}>Sort: {rspec.sortMode === "keys" && rspec.sort.length ? rspec.sort.map((k) => `${k.key}${k.desc ? " ↓" : ""}`).join(" › ") : "Python sort order"}</span>
            </div>
            <button type="button" className="btn-primary" disabled={busy || !rows.length} onClick={() => run(() => api.bomFiles.xlsx(`${name} ${doc.stage} purchasing`, [rollSheet()]))}>Download .xlsx</button>
            <button type="button" disabled={!rows.length} onClick={async () => { const g = rollupGridSpec(rollRows, unitLabels, rspec, cat.ctx, { items }); await copyText(toTsv(g)); ui.toast(`Copied ${g.length} row(s)`); }}>Copy table</button>
          </div>
          <div className="card">
            <h3>Device tag list</h3>
            <p className="muted">Every tagged line with its full hierarchical tag (per unit instance).</p>
            <button type="button" disabled={busy || !units.length} onClick={() => run(() => api.bomFiles.xlsx(`${name} device tags`, [tagSheet()]))}>Download .xlsx</button>
          </div>
          <div className="card">
            <h3>Project documentation package</h3>
            <p className="muted">Datasheets, manuals, guides and flyers of every part in the BOM ({docParts} of {partIds.length} parts have documents), a folder per part, with an index of files and links.</p>
            <div className="bubbles">
              <button type="button" className="bubble" aria-pressed={!kinds.length} onClick={() => setKinds([])}>All kinds</button>
              {docKinds.map((k) => <button key={k} type="button" className="bubble" aria-pressed={kinds.includes(k)} onClick={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])}>{k}</button>)}
            </div>
            <div className="namingbox">
              <span className="muted">File names:</span>{" "}
              {doc.naming ? <b>{doc.naming.from ? `${doc.naming.from.name} v${doc.naming.from.major}.${String(doc.naming.from.minor).padStart(3, "0")}` : "project convention"}{doc.naming.from ? " (project copy)" : ""}</b> : <span>the Edit-part <b>Standard name</b> ({editStd.label})</span>}
              <span className="muted"> + export prefix / suffix below</span>
              <div className="toolbar">
                <button type="button" className="btn-ghost" onClick={() => setNamingDlg("import")}>Import standard…</button>
                <button type="button" className="btn-ghost" disabled={!doc.naming} onClick={() => setNamingDlg("edit")}>Edit convention…</button>
                {doc.naming && <button type="button" className="btn-ghost" onClick={() => setDoc({ ...doc, naming: null })}>Use the Edit-part standard</button>}
              </div>
            </div>
            <div className="dxbox">
              <div className="frow tight" style={{ alignItems: "flex-end" }}>
                <label className="f">Part lines from
                  <select value={dx.source} onChange={(e) => setDx({ source: e.target.value as typeof dx.source })}>
                    <option value="open">the open project BOM</option>
                    <option value="latest">the latest saved project BOM version</option>
                  </select>
                </label>
                {dx.source === "latest" && <span className="muted" style={{ fontSize: 12 }}>{linked ? <>linked: <b>{linked.label}</b></> : "no saved version of this project yet"}</span>}
                <label className="chk-l"><input type="checkbox" checked={dx.unitSheets} onChange={(e) => setDx({ unitSheets: e.target.checked })} /> Add an index sheet per unit ({units.map(unitLabelOf).join(", ")})</label>
              </div>
              <label className="chk-l" title="Every BOM part line (item no.) gets its own folder with its part's files, named by the part's naming standard plus the export prefix / suffix of that line; the index has one row per part line with KIND / TITLE / FOLDER / FILE IN PACKAGE columns for every document type">
                <input type="checkbox" checked={!!dx.byLine} onChange={(e) => setDx({ byLine: e.target.checked })} /> One folder per part line (item no.) with its files
              </label>
              <div className="pyrow">
                <PyEditor compact label="Export prefix (before each file name)" value={dx.before} onChange={(v) => setDx({ before: v })} placeholder='e.g. item  or  f"{number}-{item}"'
                  part={partIds[0] ? cat.pmap.get(partIds[0]) : undefined} sub={partIds[0] ? subs[partIds[0]] : ""} extraTabs={[["Part line", wrapTab(partIds[0])]]}
                  preview={(v) => (partIds[0] ? evalWrap(v, partIds[0]) : { text: "" })} help="Python: text added before every file name of a part (per part line with “One folder per part line”). Names: item, items, unit, units, tags, project, number, client, stage and every part field." />
                <PyEditor compact label="Export suffix (after each file name)" value={dx.after} onChange={(v) => setDx({ after: v })} placeholder='e.g. stage  or  "+".join(units)'
                  part={partIds[0] ? cat.pmap.get(partIds[0]) : undefined} sub={partIds[0] ? subs[partIds[0]] : ""} extraTabs={[["Part line", wrapTab(partIds[0])]]}
                  preview={(v) => (partIds[0] ? evalWrap(v, partIds[0]) : { text: "" })} help="Python: text added after every file name of a part." />
                <PyEditor compact label="Document order (Python sort key per document)" value={dx.docOrder} onChange={(v) => setDx({ docOrder: v })} placeholder={DEFAULT_DOC_ORDER}
                  extraTabs={[["Document", [
                    { token: "kind", label: "document type (Datasheet, Manual …)" }, { token: "title", label: "title" }, { token: "file", label: "file name" },
                    { token: "std", label: "certified standard" }, { token: "prefix", label: "document prefix" }, { token: "suffix", label: "document suffix" }, { token: "pn", label: "part number" }, { token: "mfr", label: "manufacturer" },
                    { token: DEFAULT_DOC_ORDER, label: "default: datasheets, manuals, user guides first" },
                  ]]]}
                  help="Python key per document, compared element by element: orders the files of each part and the document-type columns of the index. Default: datasheets, manuals, user guides first, then the other kinds by name." />
              </div>
              {(dx.before.trim() || dx.after.trim()) && partIds[0] && (() => {
                const a = evalWrap(dx.before, partIds[0]);
                const b = evalWrap(dx.after, partIds[0]);
                return <div className={`pnres${a.error || b.error ? " err" : ""}`}><span className="muted">{cat.pmap.get(partIds[0])?.partNumber}:</span><pre>{[a.text, "‹standard name›", b.text].filter(Boolean).join("_")}</pre>{(a.error || b.error) && <span className="errtxt">{a.error || b.error}</span>}</div>;
              })()}
            </div>
            <button type="button" disabled={busy || !partIds.length} onClick={() => run(async () => {
              const wrap = Object.fromEntries(partIds.map((id) => [id, { before: evalWrap(dx.before, id).text || undefined, after: evalWrap(dx.after, id).text || undefined }]));
              const lines = Object.fromEntries(partIds.map((id) => [id, partLines.get(id)?.items.join(", ") ?? ""]));
              const unitSheets = dx.unitSheets
                ? lineUnits.map((u) => {
                    const ids = partIds.filter((id) => partLines.get(id)?.byUnit.has(u.id));
                    return { name: unitLabelOf(u), partIds: ids, lines: Object.fromEntries(ids.map((id) => [id, (partLines.get(id)?.byUnit.get(u.id) ?? []).join(", ")])) };
                  })
                : undefined;
              const byLine = dx.byLine
                ? partIds.flatMap((id) => (partLines.get(id)?.lines ?? []).map((l) => ({ item: l.item, unit: l.unit, partId: id, before: evalWrap(dx.before, id, l).text || undefined, after: evalWrap(dx.after, id, l).text || undefined })))
                : undefined;
              await api.bomFiles.docsZip(partIds, `${name} documentation`, kinds.length ? kinds : undefined, doc.naming?.std ?? editStd.std, subs, aliases, { wrap, lines, units: unitSheets, byLine, docOrder: dx.docOrder });
            })}>Download .zip</button>
          </div>
          <div className="card sortcard">
            <h3>Sort order</h3>
            <p className="muted">How the part list is ordered in the purchasing roll-up and the documentation package: a Python sort key per part, compared element by element (item numbers naturally: A2 &lt; A10).</p>
            <div className="toolbar">
              <VersionBar key={sortKey} storageKey="fpl.snap.sortformat" store={api.sortFormats} noun="sort order" data={sortFmt} canon={stableJson} defaultName="Part list order"
                describe={(d) => ({ key: d.key.slice(0, 60) })} restore={async (d) => setSortFmt({ ...DEFAULT_SORT, ...d })} />
              <button type="button" onClick={async () => {
                if (!(await ui.confirm("Start a new sort order? Unsaved changes are lost.", "New"))) return;
                localStorage.setItem("fpl.snap.sortformat", JSON.stringify({ id: null, loaded: null, pending: { major: 1, minor: 1 }, savedHash: null }));
                setSortFmt({ ...DEFAULT_SORT });
                setSortKey((k) => k + 1);
              }}>New</button>
            </div>
            <PyEditor compact label="Sort key (Python)" value={sortFmt.key} help="Python sort key per part, compared element by element: (sub, mfr, pn), item, (unit, item), -total …" onChange={(v) => setSortFmt({ ...sortFmt, key: v })} placeholder="(sub, mfr, pn)  or  item  or  (unit, item)"
              part={partIds[0] ? cat.pmap.get(partIds[0]) : undefined} sub={partIds[0] ? subs[partIds[0]] : ""} extraTabs={[["Part line", wrapTab(partIds[0]).filter((x) => !["project", "number", "client", "stage"].includes(x.token))], ["Sort", [{ token: "total", label: "total quantity" }, { token: "-total", label: "largest quantity first" }, { token: "stock", label: "in stock" }]]]} />
            <div className="frow tight" style={{ alignItems: "center" }}>
              <label className="chk-l"><input type="checkbox" checked={sortFmt.descending} onChange={(e) => setSortFmt({ ...sortFmt, descending: e.target.checked })} /> Descending</label>
              {sorted.error ? <span className="errtxt">{sorted.error}</span> : <span className="muted" style={{ fontSize: 12 }}>First: {rows.slice(0, 4).map((r) => r.partNumber).join(", ")}{rows.length > 4 ? " …" : ""}</span>}
            </div>
          </div>
          <div className="card">
            <h3>Everything</h3>
            <p className="muted">Equipment lists, purchasing roll-up, device tags and load schedules in one workbook.</p>
            <button type="button" disabled={busy || !units.length} onClick={() => run(() => api.bomFiles.xlsx(`${name} ${doc.stage} BOM`, [...eqSheets(), rollSheet(), tagSheet(), ...[loadSheet()].filter((x): x is XlsxSheet => !!x)]))}>Download .xlsx</button>
          </div>
        </div>
        {colDlg === "eq" && (
          <EqListModal spec={eqSpec} builtin={EQ_BUILTIN} ctx={cat.ctx} onClose={() => setColDlg(null)}
            preview={(sp) => equipmentLists(units.slice(0, 1), eqCtx, sp)[0] ?? null}
            onApply={(sp) => (setDoc({ ...doc, eqList: sp }), setColDlg(null))} />
        )}
        {colDlg === "roll" && (
          <RollupModal spec={rspec} ctx={cat.ctx} onClose={() => setColDlg(null)}
            preview={(sp) => rollupGridSpec(sortedBy(sp), unitLabels, sp, cat.ctx, { items })}
            onApply={(sp) => (setDoc({ ...doc, rollupSpec: sp }), setColDlg(null))} />
        )}
        {pnDlg === "import" && <ImportPnFormat onClose={() => setPnDlg(null)} onPick={(from, fmt) => (setDoc({ ...doc, pnFormat: { from, fmt } }), setPnDlg(null))} />}
        {pnDlg === "edit" && doc.pnFormat && (
          <PnRulesModal title={`Part-number format of ${name}`} fmt={doc.pnFormat.fmt} onChange={(fmt) => setDoc({ ...doc, pnFormat: { ...doc.pnFormat!, fmt } })} onClose={() => setPnDlg(null)} src={{ parts: cat.parts, subcats: [...cat.smap.values()] }} />
        )}
        {namingDlg === "import" && <ImportNaming onClose={() => setNamingDlg(null)} onPick={(from, std) => (setDoc({ ...doc, naming: { from, std } }), setNamingDlg(null))} />}
        {namingDlg === "edit" && doc.naming && (
          <Modal onClose={() => setNamingDlg(null)} label="Project naming convention">
            <div className="mh"><h3>Naming convention of {name}</h3><span className="muted" style={{ fontSize: 12.5 }}>Saved with this project BOM version; the shared standard is not changed.</span></div>
            <div className="mb"><NamingRules std={doc.naming.std} onChange={(std) => setDoc({ ...doc, naming: { ...doc.naming!, std } })} /></div>
            <div className="mf"><button type="button" className="btn-primary" onClick={() => setNamingDlg(null)}>Done</button></div>
          </Modal>
        )}
        <div className="card">
          <div className="head">
            <h3>Purchasing roll-up</h3>
            <span className="muted" style={{ fontSize: 12.5 }}>{rows.length} part numbers{noPower ? ` · ${noPower} without power data` : ""}</span>
          </div>
          {(() => {
            const g = rollupGridSpec(rollRows, unitLabels, rspec, cat.ctx, { items });
            const numCol = g[0].map((_h, i) => g.slice(1).every((r) => r[i] === "" || /^-?[\d.]+$/.test(r[i])));
            const tb = g[0].indexOf("TO BUY");
            return (
              <table className="net" ref={rollColRef}>
                <thead><tr>{g[0].map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                <tbody>
                  {g.slice(1).map((r, k) => (
                    <tr key={rollRows[k]?.key ?? k}>
                      {r.map((c, i) => <td key={i} className={numCol[i] ? "num" : g[0][i] === "DESCRIPTION" ? "desc" : undefined} title={c}>{i === tb && c && c !== "0" ? <span className="chip">{c}</span> : c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </div>
      </div>
    </section>
  );
}

/** Import a naming standard version into the project (a copy that can then be edited per project). */
function ImportNaming({ onClose, onPick }: { onClose: () => void; onPick: (from: { id: string; name: string; major: number; minor: number } | null, std: import("@fpl/core").NamingStandard) => void }) {
  const { items, refresh } = useNamingStandards();
  const [v, setV] = useState<string | null>(null);
  const [lib, setLib] = useState(false);
  const val = v ?? defaultNamingValue(items);
  return (
    <Modal size="sm" onClose={onClose} label="Import naming standard">
      <div className="mh"><h3>Import a naming standard</h3></div>
      <div className="mb">
        <label className="f">Standard and version<NamingPicker items={items} value={val} onChange={(x) => setV(x)} /></label>
        <button type="button" className="btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setLib(true)}>Edit the standards library…</button>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={async () => {
          // "latest" is resolved now: the project records the exact version it copied.
          const r = resolveNaming(val, items);
          const std = await namingFromValue(val, items);
          const it = r && items.find((x) => x.id === r.id);
          onPick(it && r ? { id: r.id, name: it.name, major: r.ver.major, minor: r.ver.minor } : null, structuredClone(std));
        }}>Import</button>
      </div>
      {lib && <NamingStandardsModal onClose={() => (setLib(false), refresh())} onChanged={refresh} />}
    </Modal>
  );
}
