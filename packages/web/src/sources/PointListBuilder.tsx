import {
  codeNames, exprNames, isLateRule, parseCode, parseExpr, PL_FILTERS, UNIT_TOKENS,
  autoMatchTypes, defaultDtSet, fmtSeries, inferStdType, parseDtTypes, PL_DT_BITS, PL_DT_FAMILIES, RESULT_TOKENS,
  type PlDtBits, type PlDtFamily, type PlDtSet, type PlSeries, type PlStdType,
  defaultReserve, defaultUnits, matchUnit, PL_RESERVE_MODES, PL_RESERVE_TYPES, ruleExample, validateTable,
  type PlReserveMode, type PlTableStats, type PlUnitRow, type PlUnits,
  blockSummary, bumpMajor, bumpMinor, colKey, colLabel, conditionTable, emptyBuild, latest, PL_FIELDS, PL_FILTER_OPS, PL_MODES, PL_PROTOCOLS,
  PL_RULES, publishGrid, parseDelimited, resultColumns, ruleDef, runBuild, stamp, suggestColumns, tableInput, verLabel,
  type Grid, type PlBuild, type PlColumn, type PlFilterOp, type PlIssue, type PlMode, type PlPlacement, type PlProtocol, type PlRule,
  type PlRuleOp, type PlSlot, type PlTable, type Ver,
} from "@fpl/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type Versioned } from "../api";
import { LibraryBar } from "../editor/LibraryBar";
import { stableJson } from "../snapshots";
import { HoldButton, Modal, Popover, Seg, useLocal, useUi } from "../ui";
import { VersionBar } from "../VersionBar";
import { FunctionsPalette, LibPicker, mergeLibs, useLibCodes, useLibItems, type LibRef } from "../pylibs";

type Tab = "inputs" | "tables" | "arrays" | "result";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).slice(0, 8);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const move = <T,>(l: T[], i: number, d: -1 | 1) => {
  const j = i + d;
  if (j < 0 || j >= l.length) return l;
  const c = l.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
};

/** Grids of the saved inputs, by "id@major.minor". */
function useInputGrids(slots: PlSlot[], items: Versioned[]) {
  const cache = useRef(new Map<string, Grid>());
  const [, bump] = useState(0);
  const resolved = slots.map((s) => {
    const it = items.find((x) => x.id === s.inputId);
    const v = s.ver ?? (it ? latest(it.versions) ?? null : null);
    return { slot: s.id, id: it ? s.inputId : null, v };
  });
  const keyOf = (id: string | null, v: Ver | null) => (id && v ? `${id}@${v.major}.${v.minor}` : "");
  const want = resolved.map((r) => keyOf(r.id, r.v)).join("|");
  useEffect(() => {
    let live = true;
    for (const r of resolved) {
      const k = keyOf(r.id, r.v);
      if (!k || cache.current.has(k)) continue;
      api.plInputs
        .getVersion(r.id!, r.v!.major, r.v!.minor)
        .then((ver) => {
          cache.current.set(k, ((ver.data as { grid?: Grid })?.grid ?? []) as Grid);
          if (live) bump((n) => n + 1);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);
  const grids: Record<string, Grid | null> = {};
  for (const r of resolved) grids[r.slot] = cache.current.get(keyOf(r.id, r.v)) ?? null;
  const put = (id: string, v: Ver, g: Grid) => {
    cache.current.set(keyOf(id, v), g);
    bump((n) => n + 1);
  };
  return { grids, resolved, put, sig: resolved.map((r) => keyOf(r.id, r.v) + (cache.current.has(keyOf(r.id, r.v)) ? "+" : "")).join("|") };
}

export function PointListBuilder({ onClose, onPublished }: { onClose: () => void; onPublished: (sourceId: string) => void }) {
  const ui = useUi();
  const [b, setB] = useLocal<PlBuild>("fpl.plb.draft", emptyBuild());
  const [tab, setTab] = useLocal<Tab>("fpl.plb.tab", "inputs");
  const [items, setItems] = useState<Versioned[]>([]);
  const refreshInputs = useCallback(() => api.plInputs.list().then(setItems).catch(() => {}), []);
  useEffect(() => {
    refreshInputs();
  }, [refreshInputs]);
  const { grids, resolved, put, sig } = useInputGrids(b.slots, items);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // Function libraries attached to the build (Functions… on a table).
  const lib = useLibItems(true, tab);
  const { codes: libCodes } = useLibCodes(b.libs ?? [], lib.items);
  const libs = useMemo(() => mergeLibs(libCodes), [libCodes.join("\u0000")]); // eslint-disable-line react-hooks/exhaustive-deps
  const extra = libs.names;
  const result = useMemo(() => runBuild(b, grids, { extra }), [b, sig, extra]); // eslint-disable-line react-hooks/exhaustive-deps
  const errors = result.issues.filter((i) => i.level === "error").length;
  const warns = result.issues.length - errors;

  const setProtocol = async (p: PlProtocol) => {
    if (p === b.protocol) return;
    const keys = new Set(PL_FIELDS[p].map((f) => f.key));
    const lost = b.tables.flatMap((t) => t.columns).filter((c) => c.field && !keys.has(c.field));
    if (lost.length && !(await ui.confirm(`${plural(lost.length, "column")} map to ${PL_PROTOCOLS[b.protocol]} fields that ${PL_PROTOCOLS[p]} does not have; they become custom columns.`, `Switch to ${PL_PROTOCOLS[p]}`))) return;
    setB({
      ...b,
      protocol: p,
      tables: b.tables.map((t) => ({ ...t, columns: t.columns.map((c) => (c.field && !keys.has(c.field) ? { ...c, name: colLabel(c, b.protocol), field: "" } : c)) })),
    });
  };

  const publish = async () => {
    if (!result.points.length) return ui.toast("Nothing to publish yet: add a table and a placement");
    if (errors && !(await ui.confirm(`The result has ${plural(errors, "error")}. Publish anyway?`, "Publish"))) return;
    const name = await ui.prompt("Point list (source) name", b.publish?.name || `${PL_PROTOCOLS[b.protocol]} point list ${stamp().slice(0, 6)}`, "Publish");
    if (!name) return;
    const { grid, protocolMap } = publishGrid(b, result, { origin: true });
    try {
      const srcs = await api.sources.list();
      const prev = b.publish?.sourceId ? srcs.find((s) => s.id === b.publish!.sourceId) : undefined;
      let id: string;
      if (prev && (await ui.confirm(`Replace the data of source "${prev.name}" (published from this build before)? Cancel creates a new source.`, "Replace"))) {
        id = (await api.sources.update(prev.id, { name, kind: b.protocol, grid, protocolMap })).id;
      } else {
        id = (await api.sources.create({ name, kind: b.protocol, grid })).id;
        await api.sources.update(id, { protocolMap });
      }
      setB({ ...b, publish: { sourceId: id, name } });
      ui.toast(`Published ${plural(result.points.length, "point")} to "${name}"`);
      onPublished(id);
    } catch (e) {
      ui.toast(`Couldn’t publish: ${errMsg(e)}`);
    }
  };

  return (
    <section className="view simple plb" aria-label="Point list builder">
      <header className="toolbar df-row1">
        <button type="button" onClick={onClose} title="Back to the source list">← Sources</button>
        <h1>Point list builder</h1>
        <label className="ctl">Protocol
          <select aria-label="Protocol" value={b.protocol} onChange={(e) => setProtocol(e.target.value as PlProtocol)}>
            {Object.entries(PL_PROTOCOLS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <span className="grow" />
        <VersionBar<PlBuild>
          storageKey="fpl.plb.lib"
          store={api.plBuilds}
          noun="build template"
          data={b}
          canon={stableJson}
          restore={async (d) => setB({ ...emptyBuild(), ...d })}
          describe={(d) => ({ protocol: d.protocol, tables: d.tables.length, placements: d.placements.length, rows: result.points.length, cols: resultColumns(d).length })}
        />
      </header>
      <div className="toolbar df-row2">
        <div className="seg plb-tabs" role="tablist" aria-label="Builder steps">
          {([
            ["inputs", `1 Inputs (${b.slots.length})`],
            ["tables", `2 Tables (${b.tables.length})`],
            ["arrays", `3 Placements & arrays (${b.placements.length})`],
            ["result", `4 Result (${result.points.length})`],
          ] as [Tab, string][]).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
              {l}
              {k === "result" && (errors || warns) ? <span className={`chip ${errors ? "err" : ""}`}>{errors ? `${errors} ✖` : `${warns} ⚠`}</span> : null}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="muted">{plural(result.points.length, "point")} · {plural(result.blocks.length, "block")} · <b style={{ color: errors ? "var(--err)" : undefined }}>{plural(errors, "error")}</b> · {plural(warns, "warning")}</span>
        <button type="button" className="btn-primary" onClick={publish} title={b.publish?.sourceId ? `Last published as "${b.publish.name}"` : "Create a point-list source from the result"}>Publish as source…</button>
      </div>
      {tab === "inputs" && <InputsTab b={b} setB={setB} items={items} refresh={refreshInputs} grids={grids} resolved={resolved} put={put} />}
      {tab === "tables" && <TablesTab b={b} setB={setB} grids={grids} setProtocol={setProtocol} extra={extra} libs={libs.libs} libItems={lib.items} refreshLibs={lib.refresh} />}
      {tab === "arrays" && <ArraysTab b={b} setB={setB} result={result} />}
      {tab === "result" && <ResultTab b={b} result={result} />}
    </section>
  );
}

type SetB = (v: PlBuild | ((p: PlBuild) => PlBuild)) => void;

// ---------------------------------------------------------------- Inputs

function InputsTab({ b, setB, items, refresh, grids, resolved, put }: {
  b: PlBuild; setB: SetB; items: Versioned[]; refresh: () => Promise<unknown>; grids: Record<string, Grid | null>;
  resolved: { slot: string; id: string | null; v: Ver | null }[]; put: (id: string, v: Ver, g: Grid) => void;
}) {
  const ui = useUi();
  const [sel, setSel] = useLocal<string>("fpl.plb.slot", "");
  const slot = b.slots.find((s) => s.id === sel) ?? b.slots[0];
  const [paste, setPaste] = useState(false);
  const [edit, setEdit] = useState<Grid | null>(null);
  const [page, setPage] = useState(0);
  useEffect(() => {
    setEdit(null);
    setPage(0);
  }, [slot?.id]);
  const setSlot = (s: PlSlot) => setB((p) => ({ ...p, slots: p.slots.map((x) => (x.id === s.id ? s : x)) }));
  const addSlot = () => {
    const s: PlSlot = { id: uid(), name: `Input ${b.slots.length + 1}`, inputId: null, ver: null };
    setB({ ...b, slots: [...b.slots, s] });
    setSel(s.id);
  };
  const grid = slot ? grids[slot.id] : null;
  const rv = resolved.find((r) => r.slot === slot?.id);
  const it = items.find((x) => x.id === slot?.inputId);
  const usedBy = (id: string) => b.tables.filter((t) => t.slot === id).map((t) => t.name);

  /** Save a grid as a new version of the slot's input (or as a new input) and bind the slot to it. */
  const saveGrid = async (g: Grid, how: "minor" | "major" | "new", name?: string) => {
    if (!slot) return;
    try {
      let id = how === "new" ? null : slot.inputId;
      const versions = it?.versions ?? [];
      const base = rv?.v ?? latest(versions) ?? null;
      let v: Ver = { major: 1, minor: 1 };
      if (id && base) v = how === "major" ? bumpMajor(base, versions) : bumpMinor(base, versions);
      if (!id) id = (await api.plInputs.create({ name: name?.trim() || slot.name })).id;
      await api.plInputs.saveVersion(id, v.major, v.minor, { stamp: stamp(), data: { grid: g }, meta: { rows: Math.max(0, g.length - 1), cols: g[0]?.length ?? 0 } });
      put(id, v, g);
      setSlot({ ...slot, inputId: id, ver: how !== "new" && slot.ver ? v : null });
      await refresh();
      ui.toast(`Saved input v${verLabel(v)} · ${plural(g.length, "row")}`);
      return true;
    } catch (e) {
      ui.toast(`Couldn’t save the input: ${errMsg(e)}`);
      return false;
    }
  };

  const PAGE = 200;
  const shown = edit ?? grid ?? [];
  const width = Math.max(0, ...shown.slice(0, 2000).map((r) => r.length));
  return (
    <main className="split list">
      <section className="pane" aria-label="Input slots">
        <div className="pane-head"><h2>Inputs</h2><span className="hint">Raw tables pasted from Excel</span><button type="button" onClick={addSlot}>+ Input</button></div>
        <div className="scroll">
          {!b.slots.length ? (
            <div className="empty-state"><h3>No inputs</h3><p>Add an input, then paste a raw table (Ctrl+V). Each input is versioned on its own.</p><button type="button" className="btn-primary" onClick={addSlot}>+ Input</button></div>
          ) : (
            <ul className="srclist">
              {b.slots.map((s) => {
                const r = resolved.find((x) => x.slot === s.id);
                const g = grids[s.id];
                return (
                  <li key={s.id}>
                    <button type="button" aria-current={s.id === slot?.id} onClick={() => setSel(s.id)}>
                      <span className="nm">{s.name}</span>
                      <span className="meta">
                        <span>{r?.id ? `${items.find((x) => x.id === r.id)?.name ?? "?"} v${r.v ? verLabel(r.v) : "–"}${s.ver ? "" : " (latest)"}` : "no data"}</span>
                        {g && <span>{plural(g.length, "row")}</span>}
                        {usedBy(s.id).length > 0 && <span>→ {usedBy(s.id).join(", ")}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
      <div />
      <section className="pane" aria-label="Input detail">
        {!slot ? (
          <div className="empty-state"><p>Add an input on the left.</p></div>
        ) : (
          <>
            <div className="pane-head plb-wrap">
              <input type="text" aria-label="Input name" value={slot.name} onChange={(e) => setSlot({ ...slot, name: e.target.value })} style={{ fontWeight: 600, minWidth: 180 }} />
              <LibraryBar
                store={api.plInputs}
                noun="input"
                profiles={items}
                profileId={slot.inputId}
                loaded={rv?.v ?? null}
                recentAll
                onPickProfile={(id) => setSlot({ ...slot, inputId: id, ver: null })}
                onLoad={(id, v) => setSlot({ ...slot, inputId: id, ver: v })}
                onChanged={refresh}
                onDetach={() => setSlot({ ...slot, inputId: null, ver: null })}
              />
              <label className="ctl" title="Use the newest saved version of this input automatically">
                <input type="checkbox" checked={!slot.ver} disabled={!slot.inputId} onChange={(e) => setSlot({ ...slot, ver: e.target.checked ? null : rv?.v ?? null })} /> Follow latest
              </label>
              <span className="tools">
                <button type="button" className="btn-primary" onClick={() => setPaste(true)}>Paste table…</button>
                {edit ? (
                  <>
                    <button type="button" onClick={() => setEdit([...edit, Array(width).fill("")])}>+ Row</button>
                    <button type="button" onClick={() => setEdit(edit.map((r) => [...r, ""]))}>+ Column</button>
                    <button type="button" onClick={() => setEdit(null)}>Discard</button>
                    <button type="button" className="btn-primary" onClick={async () => (await saveGrid(edit, "minor")) && setEdit(null)}>Save edits as sub-version</button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={!grid} onClick={() => setEdit(grid!.map((r) => r.slice()))}>Edit cells</button>
                    <HoldButton label="Remove this input from the build" onHold={() => setB({ ...b, slots: b.slots.filter((x) => x.id !== slot.id) })}>Remove</HoldButton>
                  </>
                )}
              </span>
            </div>
            <div className="scroll">
              {!shown.length ? (
                <div className="empty-state"><h3>No data</h3><p>Paste a table copied from Excel, or pick a saved input above.</p></div>
              ) : (
                <div className="plb-grid">
                  <table className={`grid${edit ? " editing" : ""}`}>
                    <thead><tr><th className="idx">Row</th>{Array.from({ length: width }, (_, j) => <th key={j}>{colLetter(j)}</th>)}{edit && <th />}</tr></thead>
                    <tbody>
                      {shown.slice(page * PAGE, page * PAGE + PAGE).map((r, i0) => {
                        const i = page * PAGE + i0;
                        return (
                          <tr key={i}>
                            <td className="idx">{i + 1}</td>
                            {Array.from({ length: width }, (_, j) =>
                              edit ? (
                                <td key={j} className="ed"><input aria-label={`Row ${i + 1} column ${colLetter(j)}`} value={r[j] ?? ""} onChange={(e) => setEdit(edit.map((row, k) => (k === i ? Object.assign(row.slice(), { [j]: e.target.value }) : row)))} /></td>
                              ) : (
                                <td key={j} className={(r[j] ?? "") === "" ? "empty" : undefined}>{r[j]}</td>
                              ))}
                            {edit && <td><button type="button" className="btn-ghost" aria-label={`Delete row ${i + 1}`} onClick={() => setEdit(edit.filter((_, k) => k !== i))}>✕</button></td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {shown.length > PAGE && <Pager page={page} pages={Math.ceil(shown.length / PAGE)} setPage={setPage} />}
            </div>
          </>
        )}
      </section>
      {paste && slot && <PasteModal slot={slot} hasInput={!!it} onClose={() => setPaste(false)} onSave={async (g, how, name) => (await saveGrid(g, how, name)) && setPaste(false)} />}
    </main>
  );
}

const colLetter = (j: number) => {
  let s = "";
  for (let n = j + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function Pager({ page, pages, setPage }: { page: number; pages: number; setPage: (n: number) => void }) {
  return (
    <div className="toolbar plb-pager">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
      <span className="muted">Page {page + 1} of {pages}</span>
      <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next ›</button>
    </div>
  );
}

function PasteModal({ slot, hasInput, onClose, onSave }: { slot: PlSlot; hasInput: boolean; onClose: () => void; onSave: (g: Grid, how: "minor" | "major" | "new", name?: string) => void }) {
  const [text, setText] = useState("");
  const [how, setHow] = useState<"minor" | "major" | "new">(hasInput ? "minor" : "new");
  const [name, setName] = useState(slot.name);
  const g = text.trim() ? parseDelimited(text) : [];
  return (
    <Modal onClose={onClose} label="Paste table">
      <div className="mh"><h3>Paste a raw table into “{slot.name}”</h3></div>
      <div className="mb">
        <label className="f">Cells copied from Excel (all rows, including titles; pick the header row per table later)
          <textarea rows={12} autoFocus value={text} placeholder="Click here and press Ctrl+V" onChange={(e) => setText(e.target.value)} style={{ fontFamily: "var(--f-mono)", fontSize: 12 }} />
        </label>
        <div className="toolbar">
          <Seg<"minor" | "major" | "new"> label="Save as" value={how} onChange={setHow} options={hasInput ? [["minor", "Next sub-version"], ["major", "Next version"], ["new", "New input"]] : [["new", "New input"]]} />
          {how === "new" && <label className="ctl">Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>}
          <span className="muted">{g.length ? `${plural(g.length, "row")} × ${g[0]?.length ?? 0} columns` : "Nothing pasted yet"}</span>
        </div>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!g.length} onClick={() => onSave(g, how, name)}>Save input</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Tables

const SPACE_NOUN: Record<PlProtocol, string> = { modbus: "registers", dnp3: "indexes", iec104: "addresses" };

function TablesTab({ b, setB, grids, setProtocol, extra, libs, libItems, refreshLibs }: {
  b: PlBuild; setB: SetB; grids: Record<string, Grid | null>; setProtocol: (p: PlProtocol) => void;
  extra: ReturnType<typeof mergeLibs>["names"]; libs: ReturnType<typeof mergeLibs>["libs"]; libItems: Versioned[]; refreshLibs: () => unknown;
}) {
  const [libsOpen, setLibsOpen] = useState(false);
  const ui = useUi();
  const [stats, setStats] = useState<{ st: PlTableStats; strides: number } | null>(null);
  const [unitsOpen, setUnitsOpen] = useState(false);
  const [dtOpen, setDtOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [exprEd, setExprEd] = useState<{ colId: string; idx: number } | null>(null);
  const [sel, setSel] = useLocal<string>("fpl.plb.table", "");
  const t = b.tables.find((x) => x.id === sel) ?? b.tables[0];
  const [inst, setInst] = useState(1);
  const setT = (n: PlTable) => setB((p) => ({ ...p, tables: p.tables.map((x) => (x.id === n.id ? n : x)) }));
  const add = (copy?: PlTable) => {
    const n: PlTable = copy
      ? { ...structuredClone(copy), id: uid(), name: `${copy.name} copy` }
      : { id: uid(), name: `Table ${b.tables.length + 1}`, slot: b.slots[0]?.id ?? "", headerRow: 1, filters: [], columns: [] };
    // A new table is placed once by default.
    const pl: PlPlacement = { id: uid(), name: "", table: n.id, count: 1, mode: "start", start: 0, stride: 0, gap: 0, nStart: 1 };
    setB({ ...b, tables: [...b.tables, n], placements: [...b.placements, pl] });
    setSel(n.id);
  };
  const grid = t ? grids[t.slot] : null;
  const inp = t ? tableInput(t, grid) : { headers: [], rows: [], first: 0 };
  const headers = inp.headers.filter((h) => h);
  const rows = useMemo(() => (t ? conditionTable(t, grid, inst, 1, b.dataTypes, extra) : []), [t, grid, inst, b.dataTypes, extra]);
  const fields = PL_FIELDS[b.protocol];
  const unusedFields = t ? fields.filter((f) => !t.columns.some((c) => c.field === f.key)) : [];
  const setCol = (c: PlColumn) => t && setT({ ...t, columns: t.columns.map((x) => (x.id === c.id ? c : x)) });
  const [page, setPage] = useState(0);
  const PAGE = 200;
  const kept = inp.rows.filter((r) => r.some((v) => String(v).trim())).length;
  const res = t?.reserve ?? defaultReserve(b.protocol);
  const showScale = !!t?.units?.on;
  const previewCols: { key: string; label: string }[] = t ? t.columns.map((c) => ({ key: colKey(c), label: colLabel(c, b.protocol) })) : [];
  if (showScale) {
    const at = previewCols.findIndex((c) => c.key === "dataType");
    previewCols.splice(at >= 0 ? at + 1 : previewCols.length, 0, { key: "scaledUnit", label: "Scaled-Unit" }, { key: "unitScale", label: "Unit-Scaling" });
  }
  const validate = () => {
    if (!t) return;
    const st = validateTable(b, t.id, grid, extra);
    if (!st.spaces.length) return ui.toast("Nothing to validate: no points with an address / index");
    // A validated table sets the stride of its placements to its block size.
    const n = b.placements.filter((p) => p.table === t.id).length;
    setB((p) => ({
      ...p,
      tables: p.tables.map((x) => (x.id === t.id ? { ...x, validated: { at: new Date().toISOString(), span: st.stride } } : x)),
      placements: p.placements.map((x) => (x.table === t.id ? { ...x, stride: st.stride } : x)),
    }));
    setStats({ st, strides: n });
  };

  return (
    <main className="split list">
      <section className="pane" aria-label="Tables">
        <div className="pane-head"><h2>Tables</h2><span className="hint">Conditioning rules per input</span><button type="button" disabled={!b.slots.length} onClick={() => add()}>+ Table</button></div>
        <div className="scroll">
          {!b.tables.length ? (
            <div className="empty-state"><h3>No tables</h3><p>{b.slots.length ? "A table picks an input, filters its rows and builds each point-list column with a chain of rules." : "Add an input first."}</p><button type="button" className="btn-primary" disabled={!b.slots.length} onClick={() => add()}>+ Table</button></div>
          ) : (
            <ul className="srclist">
              {b.tables.map((x) => (
                <li key={x.id}>
                  <button type="button" aria-current={x.id === t?.id} onClick={() => setSel(x.id)}>
                    <span className="nm">{x.name}</span>
                    <span className="meta">
                      <span>{b.slots.find((s) => s.id === x.slot)?.name ?? "no input"}</span>
                      <span>{plural(x.columns.length, "column")}</span>
                      <span>{plural(b.placements.filter((p) => p.table === x.id).length, "placement")}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <div />
      <section className="pane" aria-label="Table rules">
        {!t ? (
          <div className="empty-state"><p>Add a table on the left.</p></div>
        ) : (
          <div className="scroll">
            <div className="card">
              <div className="head">
                <input type="text" aria-label="Table name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} style={{ fontWeight: 600, minWidth: 200 }} />
                <label className="ctl">Input
                  <select value={t.slot} onChange={(e) => setT({ ...t, slot: e.target.value })}>
                    <option value="">— none —</option>
                    {b.slots.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="ctl" title="Row of the input holding the column headers; rows above are ignored">Header row
                  <input type="number" min={1} value={t.headerRow} onChange={(e) => setT({ ...t, headerRow: Math.max(1, +e.target.value || 1) })} style={{ width: 60 }} />
                </label>
                <span className="muted">{grid ? `${rows.length} of ${kept} rows kept` : "input has no data"}</span>
                <span style={{ flex: 1 }} />
                <span className="valgrp" title="Protocol of this point list (applies to every table of the build)">
                  <select aria-label="Table protocol" value={b.protocol} onChange={(e) => setProtocol(e.target.value as PlProtocol)}>
                    {Object.entries(PL_PROTOCOLS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <HoldButton ms={200} className="btn-primary" label={`Validate ${t.name} as ${PL_PROTOCOLS[b.protocol]}`} onHold={validate}><span aria-hidden="true">🔬</span> Validate</HoldButton>
                </span>
                {t.validated && <span className="chip info" title={`Validated ${new Date(t.validated.at).toLocaleString()}`}>block {t.validated.span}</span>}
                <button type="button" className={t.units?.on ? "on" : undefined} onClick={() => setUnitsOpen(true)} title="Unit conditioning: proper unit spelling and the Unit-Scaling column">Units…{t.units?.on ? " ✓" : ""}</button>
                <button type="button" className={t.dtMap?.on ? "on" : undefined} onClick={() => setDtOpen(true)} title="Map the raw data types of this table to the standard data types">Data types…{t.dtMap?.on ? " ✓" : ""}</button>
                <button type="button" className={b.series?.length ? "on" : undefined} onClick={() => setSeriesOpen(true)} title="Numbered series used as {series:Name}">Series…{b.series?.length ? ` (${b.series.length})` : ""}</button>
                <button type="button" className={b.libs?.length ? "on" : undefined} onClick={() => (refreshLibs(), setLibsOpen(true))} title="Custom Python functions (saved function libraries) for Expression / Python code rules">Functions…{b.libs?.length ? ` (${libs.flatMap((l) => l.funcs).length})` : ""}</button>
                <button type="button" onClick={() => add(t)}>Duplicate</button>
                <HoldButton label={`Delete table ${t.name}`} onHold={() => setB({ ...b, tables: b.tables.filter((x) => x.id !== t.id), placements: b.placements.filter((p) => p.table !== t.id) })}>Delete</HoldButton>
              </div>
            </div>

            <div className="card">
              <div className="head"><h3>Row filters</h3><span className="muted">Rows must pass every filter. Blank rows are always skipped.</span>
                <button type="button" disabled={!headers.length} onClick={() => setT({ ...t, filters: [...t.filters, { col: headers[0] ?? "", op: "notEmpty" }] })}>+ Filter</button>
              </div>
              {t.filters.map((f, i) => (
                <div className="toolbar sub" key={i}>
                  <select aria-label="Filter column" value={f.col} onChange={(e) => setT({ ...t, filters: t.filters.map((x, k) => (k === i ? { ...x, col: e.target.value } : x)) })}>
                    {!headers.includes(f.col) && <option value={f.col}>{f.col || "—"} (missing)</option>}
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <select aria-label="Filter condition" value={f.op} onChange={(e) => setT({ ...t, filters: t.filters.map((x, k) => (k === i ? { ...x, op: e.target.value as PlFilterOp } : x)) })}>
                    {PL_FILTER_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {f.op !== "empty" && f.op !== "notEmpty" && <input type="text" aria-label="Filter value" value={f.value ?? ""} onChange={(e) => setT({ ...t, filters: t.filters.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) })} />}
                  <button type="button" className="btn-ghost" aria-label="Remove filter" onClick={() => setT({ ...t, filters: t.filters.filter((_, k) => k !== i) })}>✕</button>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="head">
                <h3>Undeclared {SPACE_NOUN[b.protocol]}</h3>
                <span className="muted">Between the first and last declared {SPACE_NOUN[b.protocol].slice(0, -1)} of each block.</span>
              </div>
              <div className="toolbar sub">
                <Seg<PlReserveMode> label="Undeclared registers" value={res.mode} options={PL_RESERVE_MODES} onChange={(mode) => setT({ ...t, reserve: { ...res, mode } })} />
                {res.mode !== "leave" && (
                  <label className="ctl">Reserved as
                    <select aria-label="Reserved data type" value={res.dataType} onChange={(e) => setT({ ...t, reserve: { ...res, dataType: e.target.value } })}>
                      {PL_RESERVE_TYPES[b.protocol].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </label>
                )}
                {res.mode === "gapN" && (
                  <label className="ctl">n per gap
                    <input type="number" aria-label="Reserved per gap" min={0} value={res.n} onChange={(e) => setT({ ...t, reserve: { ...res, n: Math.max(0, Math.floor(+e.target.value || 0)) } })} style={{ width: 64 }} />
                  </label>
                )}
                <span className="muted">
                  {res.mode === "fill" ? "Every gap becomes RESERVED_<type>_<address> points (coils/DI and BI/BO use bool)." : res.mode === "gapN" ? `Only the first ${res.n} ${SPACE_NOUN[b.protocol]} of each gap are reserved; the rest stay free.` : "Gaps stay free: a placement set to “Into free registers” can use them."}
                </span>
              </div>
            </div>

            <div className="card">
              <div className="head">
                <h3>Columns</h3>
                <span className="muted">Protocol data allocates a column to a {PL_PROTOCOLS[b.protocol]} field; leave it empty for informative columns. Each column starts from an input column (or empty) and runs its rules left to right. Placeholders: {"{n} {nn} {i} {row} {col:Header} {out:field} {series:Name} {Result!address}"}</span>
                <Popover label="Placeholder syntax" button="Syntax…">
                  {() => (
                    <table className="vt syntax">
                      <tbody>
                        <tr><th colSpan={2}>While conditioning (Tables preview)</th></tr>
                        <tr><td><code>{"{n}"}</code> <code>{"{nn}"}</code> <code>{"{nnn}"}</code></td><td>Array instance number, padded to 2 / 3 digits</td></tr>
                        <tr><td><code>{"{i}"}</code></td><td>Instance counted from 0</td></tr>
                        <tr><td><code>{"{row}"}</code></td><td>Row number within the table</td></tr>
                        <tr><td><code>{"{col:Header}"}</code></td><td>Input column value in the same row</td></tr>
                        <tr><td><code>{"{out:Column name}"}</code></td><td>Output column by its name (or field), e.g. {"{out:Source_Device}"}, {"{out:tag}"}; a column computed later in the row is filled in the Result</td></tr>
                        <tr><th colSpan={2}>After placement (shown as written until the Result)</th></tr>
                        <tr><td><code>{"{series:Name}"}</code></td><td>Next number of a series (Series…); the same number for every use in one row</td></tr>
                        {RESULT_TOKENS.map(([k, d]) => <tr key={k}><td><code>{`{Result!${k}}`}</code></td><td>{d}</td></tr>)}
                        {UNIT_TOKENS.map(([k, d]) => <tr key={k}><td><code>{`{unit:${k}}`}</code></td><td>{d}</td></tr>)}
                        <tr><th colSpan={2}>Filters — append to any placeholder, e.g. {"{Result!address|pad:4}"}</th></tr>
                        {PL_FILTERS.map(([k, d]) => <tr key={k}><td><code>{`|${k}`}</code></td><td>{d}</td></tr>)}
                        <tr><th colSpan={2}>Names with spaces or symbols</th></tr>
                        <tr><td><code>{"{col:Register Type}"}</code></td><td>Spaces and most symbols work as typed (exact header). Names containing <code>{"}"}</code> or <code>|</code>: use an Expression rule, <code>{'col["a|b}"]'}</code></td></tr>
                      </tbody>
                    </table>
                  )}
                </Popover>
                <span style={{ flex: 1 }} />
                <button type="button" disabled={!headers.length} title="Create one column per protocol field, guessing the input column from header names" onClick={async () => {
                  if (t.columns.length && !(await ui.confirm("Replace the columns of this table with guessed ones?", "Replace"))) return;
                  setT({ ...t, columns: suggestColumns(b.protocol, headers, uid) });
                }}>Auto-map</button>
                <select aria-label="Add field column" value="" onChange={(e) => {
                  const f = fields.find((x) => x.key === e.target.value);
                  if (f) setT({ ...t, columns: [...t.columns, { id: uid(), field: f.key, type: f.type, source: "", rules: [] }] });
                }}>
                  <option value="">+ Protocol field…</option>
                  {unusedFields.map((f) => <option key={f.key} value={f.key}>{f.label}{f.required ? " *" : ""}</option>)}
                </select>
                <button type="button" onClick={() => setT({ ...t, columns: [...t.columns, { id: uid(), field: "", name: `Column ${t.columns.length + 1}`, type: "str", source: "", rules: [] }] })}>+ Column</button>
              </div>
              <table className="vt plb-cols">
                <thead><tr><th title="Protocol field this column is allocated to">Protocol data</th><th>Column</th><th>Type</th><th>Starts from</th><th>Rules</th><th>First value</th><th /></tr></thead>
                <tbody>
                  {t.columns.map((c, i) => {
                    const f = fields.find((x) => x.key === c.field);
                    const w = rows.reduce((n, r) => n + (r.warn[colKey(c)]?.length ?? 0), 0);
                    return (
                      <tr key={c.id}>
                        <td title={f?.hint}>
                          <select aria-label="Protocol data" value={c.field} className={c.field ? "pd on" : "pd"} onChange={(e) => {
                            const nf = fields.find((x) => x.key === e.target.value);
                            setCol({ ...c, field: e.target.value, type: nf?.type ?? c.type, name: nf ? c.name : c.name || f?.label || "" });
                          }}>
                            <option value="">— informative —</option>
                            {fields.map((x) => <option key={x.key} value={x.key} disabled={x.key !== c.field && t.columns.some((y) => y.field === x.key)}>{x.label}{x.required ? " *" : ""}</option>)}
                          </select>
                        </td>
                        <td>
                          <input type="text" aria-label="Column name" value={c.name ?? ""} placeholder={f?.label ?? "Column name"} onChange={(e) => setCol({ ...c, name: e.target.value })} style={{ width: 140 }} />
                        </td>
                        <td>
                          <select aria-label="Value type" value={c.type} onChange={(e) => setCol({ ...c, type: e.target.value as "num" | "str" })}>
                            <option value="str">text</option>
                            <option value="num">number</option>
                          </select>
                        </td>
                        <td>
                          <select aria-label="Input column" value={c.source} onChange={(e) => setCol({ ...c, source: e.target.value })}>
                            <option value="">— empty —</option>
                            {c.source && !headers.includes(c.source) && <option value={c.source}>{c.source} (missing)</option>}
                            {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </td>
                        <td><RuleChain rules={c.rules} onChange={(rules) => setCol({ ...c, rules })} openExpr={(idx) => setExprEd({ colId: c.id, idx })} /></td>
                        <td className={`mono sample${w ? " warn" : ""}`} title={w ? `${plural(w, "warning")} in this column` : undefined}>{rows[0]?.v[colKey(c)] ?? ""}{w ? ` ⚠${w}` : ""}</td>
                        <td className="nowrap">
                          <button type="button" className="btn-ghost" aria-label="Move up" onClick={() => setT({ ...t, columns: move(t.columns, i, -1) })}>↑</button>
                          <button type="button" className="btn-ghost" aria-label="Move down" onClick={() => setT({ ...t, columns: move(t.columns, i, 1) })}>↓</button>
                          <button type="button" className="btn-ghost" aria-label="Remove column" onClick={() => setT({ ...t, columns: t.columns.filter((x) => x.id !== c.id) })}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                  {!t.columns.length && <tr><td colSpan={7} className="muted">No columns yet. Use Auto-map, + Protocol field… or + Column.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="card">
              <div className="head">
                <h3>Preview</h3>
                <label className="ctl" title="Instance number used for {n} placeholders in this preview">Instance {"{n}"}
                  <input type="number" value={inst} onChange={(e) => setInst(+e.target.value || 0)} style={{ width: 60 }} />
                </label>
                <span className="muted">{plural(rows.length, "row")} before placement (addresses as in the input)</span>
              </div>
              <div className="preview">
                <table className="grid">
                  <thead><tr><th className="idx">In</th>{previewCols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    {rows.slice(page * PAGE, page * PAGE + PAGE).map((r, i) => (
                      <tr key={i}>
                        <td className="idx" title="Input row">{r.src}</td>
                        {previewCols.map((c) => {
                          const w = r.warn[c.key];
                          return <td key={c.key} className={w ? "cellwarn" : (r.v[c.key] ?? "") === "" ? "empty" : undefined} title={w?.join("\n")}>{r.v[c.key]}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > PAGE && <Pager page={page} pages={Math.ceil(rows.length / PAGE)} setPage={setPage} />}
            </div>
          </div>
        )}
      </section>
      {stats && t && <ValidateModal name={t.name} protocol={b.protocol} st={stats.st} strides={stats.strides} onClose={() => setStats(null)} />}
      {dtOpen && t && (
        <DataTypesModal
          table={t}
          set={b.dataTypes ?? defaultDtSet()}
          raws={conditionTable({ ...t, dtMap: undefined }, grid, inst, 1, undefined, extra).map((r) => (r.v.dataType ?? "").trim()).filter(Boolean)}
          hasCol={t.columns.some((c) => c.field === "dataType")}
          onSet={(dataTypes) => setB((p) => ({ ...p, dataTypes }))}
          onMap={(dtMap) => setT({ ...t, dtMap })}
          onClose={() => setDtOpen(false)}
        />
      )}
      {exprEd && t && t.columns.find((c) => c.id === exprEd.colId)?.rules[exprEd.idx] && ["expr", "code"].includes(t.columns.find((c) => c.id === exprEd.colId)!.rules[exprEd.idx].op) && (
        <ExpressionBuilder b={b} t={t} colId={exprEd.colId} idx={exprEd.idx} grids={grids} extra={extra} libs={libs}
          libItems={libItems} refreshLibs={refreshLibs} onLibs={(r) => setB((p) => ({ ...p, libs: r }))}
          onApply={(src, op) => {
            const c = t.columns.find((x) => x.id === exprEd.colId)!;
            setCol({ ...c, rules: c.rules.map((r, k) => (k === exprEd.idx ? { ...r, op, a: src } : r)) });
            setExprEd(null);
          }}
          onClose={() => setExprEd(null)} />
      )}
      {libsOpen && (
        <Modal onClose={() => setLibsOpen(false)} label="Function libraries">
          <div className="mh"><h3>Function libraries</h3><span className="muted">Shared by every table of this build</span></div>
          <div className="mb">
            <p className="muted" style={{ margin: 0 }}>Saved Python function libraries (written in JSON editor → 5 Functions) whose functions can be called from Expression and Python code rules, e.g. <code>first_number(value, "_")</code>. Pick a version or Latest.</p>
            <LibPicker refs={b.libs ?? []} onChange={(r) => setB((p) => ({ ...p, libs: r }))} items={libItems} />
            {libs.some((l) => l.error) && <span className="chip err">{libs.find((l) => l.error)!.error}</span>}
            <table className="vt funcs-list"><tbody>
              {libs.flatMap((l) => l.funcs).map((f) => <tr key={f.name}><td><code>{f.sig}</code>{f.doc && <div className="muted doc">{f.doc}</div>}</td></tr>)}
            </tbody></table>
          </div>
          <div className="mf"><button type="button" className="btn-primary" onClick={() => setLibsOpen(false)}>Done</button></div>
        </Modal>
      )}
      {seriesOpen && <SeriesModal series={b.series ?? []} onChange={(series) => setB((p) => ({ ...p, series }))} onClose={() => setSeriesOpen(false)} />}
      {unitsOpen && t && <UnitsModal protocol={b.protocol} table={t} rows={rows.map((r) => r.v)} onChange={(units) => setT({ ...t, units })} onClose={() => setUnitsOpen(false)} />}
    </main>
  );
}

function ValidateModal({ name, protocol, st, strides, onClose }: { name: string; protocol: PlProtocol; st: PlTableStats; strides: number; onClose: () => void }) {
  const noun = SPACE_NOUN[protocol];
  return (
    <Modal onClose={onClose} label="Table validation">
      <div className="mh"><h3>Validation · {name} · {PL_PROTOCOLS[protocol]}</h3></div>
      <div className="mb">
        <table className="vt valstats">
          <thead>
            <tr><th>Space</th><th>Start address</th><th>End address</th><th>Total {noun} used</th><th>% active signals</th><th>Reserved</th><th>Free {noun}</th><th>Points</th></tr>
          </thead>
          <tbody>
            {st.spaces.map((x) => (
              <tr key={x.space}>
                <td><b>{x.space}</b></td>
                <td className="mono">{x.start}</td>
                <td className="mono">{x.end}</td>
                <td className="mono">{x.used} of {x.span}</td>
                <td><span className="util"><i style={{ width: `${Math.round(x.utilization * 100)}%` }} /></span> {(x.utilization * 100).toFixed(1)} %</td>
                <td className="mono">{x.reserved}</td>
                <td className="mono">{x.free}</td>
                <td className="mono">{x.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ margin: 0 }}>
          Block size {st.stride} {noun}{strides ? ` → stride set to ${st.stride} in ${plural(strides, "placement")} of this table (Placements & arrays).` : "."} {plural(st.points, "point")} · <b style={{ color: st.errors ? "var(--err)" : undefined }}>{plural(st.errors, "error")}</b> · {plural(st.warnings, "warning")}
        </p>
        {st.issues.length > 0 && (
          <div className="issues">
            <table><tbody>
              {st.issues.slice(0, 50).map((i, k) => <tr key={k}><td className={`lvl-${i.level}`}>{i.level === "error" ? "Error" : "Warning"}</td><td>{i.msg}</td></tr>)}
            </tbody></table>
          </div>
        )}
      </div>
      <div className="mf"><button type="button" className="btn-primary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

const PROTO_TAG: Record<PlProtocol, string> = { modbus: "ModbusTCP", dnp3: "DNP3", iec104: "IEC104" };
const unitsCsv = (rows: PlUnitRow[]) =>
  ["Variable;Accepted units (case-insensitive);Proper spelling;Desired unit", ...rows.map((r) => [r.variable, r.match, r.proper, r.desired].join(";"))].join("\n");
function parseUnits(text: string): PlUnitRow[] | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t);
      const rows = Array.isArray(j) ? j : j.rows;
      return Array.isArray(rows) ? rows.map((r: Partial<PlUnitRow>) => ({ variable: String(r.variable ?? ""), match: String(r.match ?? ""), proper: String(r.proper ?? ""), desired: String(r.desired ?? "") })) : null;
    } catch {
      return null;
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const d = lines[0].includes("\t") ? "\t" : ";";
  const body = /variable/i.test(lines[0]) ? lines.slice(1) : lines;
  return body.map((l) => {
    const [variable = "", match = "", proper = "", desired = ""] = l.split(d).map((x) => x.trim());
    return { variable, match, proper, desired };
  });
}
const download = (name: string, text: string, type: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/** Unit conditioning of one table: accepted units → proper spelling → desired unit, versioned as <Protocol>-<Category>. */
function UnitsModal({ protocol, table, rows, onChange, onClose }: { protocol: PlProtocol; table: PlTable; rows: Record<string, string>[]; onChange: (u: PlUnits) => void; onClose: () => void }) {
  const ui = useUi();
  const u = table.units ?? defaultUnits();
  const set = (p: Partial<PlUnits>) => onChange({ ...u, ...p });
  const setRow = (i: number, p: Partial<PlUnitRow>) => set({ rows: u.rows.map((r, k) => (k === i ? { ...r, ...p } : r)) });
  const [imp, setImp] = useState<string | null>(null);
  const baseName = `${PROTO_TAG[protocol]}-${(u.name || "Units").replace(/\s+/g, "")}`;
  // Units found in the table and how they condition.
  const seen = [...new Set(rows.map((r) => (r.units ?? "").trim()).filter(Boolean))];
  const hasUnits = table.columns.some((c) => c.field === "units");
  return (
    <Modal onClose={onClose} label="Unit conditioning">
      <div className="mh"><h3>Unit conditioning · {table.name}</h3>
        <label className="ctl"><input type="checkbox" checked={u.on} onChange={(e) => set({ on: e.target.checked })} /> Apply to this table</label>
      </div>
      <div className="mb">
        <div className="toolbar sub">
          <label className="ctl">Category <input type="text" aria-label="Unit category" value={u.name} onChange={(e) => set({ name: e.target.value })} style={{ width: 150 }} /></label>
          <span className="grow" />
          <VersionBar<PlUnits>
            storageKey={`fpl.plb.units.${table.id}`}
            store={api.unitSets}
            noun="unit set"
            defaultName={baseName}
            data={u}
            canon={stableJson}
            restore={async (d) => onChange({ ...defaultUnits(), ...d, on: u.on })}
            describe={(d) => ({ protocol, rows: d.rows.length, cols: 4 })}
          />
        </div>
        {!hasUnits && <p className="chip" style={{ alignSelf: "flex-start" }}>No column is allocated to Units in this table: set Protocol data = Units on the column holding the unit.</p>}
        <table className="vt unitrows">
          <thead><tr><th>Variable</th><th title="Matched case-insensitively; first match wins">Accepted units</th><th title="Same order as Accepted units">Proper spelling</th><th>Desired unit</th><th /></tr></thead>
          <tbody>
            {u.rows.map((r, i) => (
              <tr key={i}>
                <td><input type="text" aria-label={`Variable ${i + 1}`} value={r.variable} onChange={(e) => setRow(i, { variable: e.target.value })} /></td>
                <td><input type="text" aria-label={`Accepted units ${i + 1}`} value={r.match} placeholder="var, kvar, mvar" onChange={(e) => setRow(i, { match: e.target.value })} /></td>
                <td><input type="text" aria-label={`Proper spelling ${i + 1}`} value={r.proper} placeholder="VAR, kVAR, MVAR" onChange={(e) => setRow(i, { proper: e.target.value })} /></td>
                <td><input type="text" aria-label={`Desired unit ${i + 1}`} value={r.desired} placeholder="kVAR" onChange={(e) => setRow(i, { desired: e.target.value })} style={{ width: 90 }} /></td>
                <td className="nowrap">
                  <button type="button" className="btn-ghost" aria-label="Move up" onClick={() => set({ rows: move(u.rows, i, -1) })}>↑</button>
                  <HoldButton label={`Delete ${r.variable || "row"}`} onHold={() => set({ rows: u.rows.filter((_, k) => k !== i) })}>✕</HoldButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="toolbar sub">
          <button type="button" onClick={() => set({ rows: [...u.rows, { variable: "", match: "", proper: "", desired: "" }] })}>+ Variable</button>
          <button type="button" onClick={async () => (await ui.confirm("Replace the rows with the default power and energy set?", "Reset")) && set({ rows: defaultUnits().rows })}>Defaults</button>
          <span className="grow" />
          <button type="button" onClick={() => setImp("")}>Import…</button>
          <button type="button" onClick={() => download(`${baseName}.json`, JSON.stringify({ protocol, name: u.name, rows: u.rows }, null, 2), "application/json")}>Export JSON</button>
          <button type="button" onClick={() => download(`${baseName}.csv`, unitsCsv(u.rows), "text/csv")}>Export CSV</button>
        </div>
        {imp != null && (
          <div className="card">
            <label className="f">Paste JSON (as exported) or rows Variable;Accepted;Proper;Desired (tab or ; separated)
              <textarea rows={6} value={imp} onChange={(e) => setImp(e.target.value)} style={{ fontFamily: "var(--f-mono)", fontSize: 12 }} />
            </label>
            <div className="toolbar sub">
              <label className="btn">Open file…<input type="file" accept=".json,.csv,.txt,.tsv" onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) setImp(await f.text());
              }} /></label>
              <span className="grow" />
              <button type="button" onClick={() => setImp(null)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => {
                const r = parseUnits(imp);
                if (!r?.length) return ui.toast("Nothing to import: paste JSON or Variable;Accepted;Proper;Desired rows");
                set({ rows: r });
                setImp(null);
                ui.toast(`Imported ${plural(r.length, "variable")}`);
              }}>Import</button>
            </div>
          </div>
        )}
        <div className="head"><h3>Units in this table</h3><span className="muted">Scaled-Unit = the desired unit of the row's variable; Unit-Scaling = factor that converts the row's unit to it (from SI prefixes).</span></div>
        <div className="bubbles">
          {seen.length ? seen.map((x) => {
            const m = matchUnit(u.rows, x);
            return <span key={x} className={`chip${m ? " info" : ""}`} title={m ? `${m.variable}: ${m.proper} → ${m.desired}` : "Not matched"}>{x}{m ? ` → ${m.proper} · ×${m.factor ?? "?"} to ${m.desired}` : " (no match)"}</span>;
          }) : <span className="muted">No unit values{hasUnits ? "" : " (no Units column)"}.</span>}
        </div>
      </div>
      <div className="mf"><span className="info">Saved versions are named {baseName} v1.001, v1.002…</span><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

const ruleText = (r: PlRule) => {
  const d = ruleDef(r.op);
  if (r.op === "code") return `ƒ code: ${(r.a ?? "").split("\n").filter((l) => l.trim())[0]?.slice(0, 28) ?? "(empty)"}…`;
  if (r.op === "expr") return `ƒ ${(r.a ?? "").length > 34 ? (r.a ?? "").slice(0, 33) + "…" : r.a || "(empty)"}`;
  const a = r.op === "map" ? `${(r.a ?? "").split("\n").filter((l) => l.includes("=")).length} pairs` : r.op === "case" || r.op === "hex" || r.op === "modicon" ? d?.params[0].options?.find((o) => o[0] === r.a)?.[1] ?? r.a : r.a;
  return `${d?.label ?? r.op}${a ? `: ${a}` : ""}${r.op === "replace" ? ` → ${r.b ?? ""}` : ""}`;
};

export function RuleChain({ rules, onChange, openExpr }: { rules: PlRule[]; onChange: (r: PlRule[]) => void; openExpr: (idx: number) => void }) {
  const groups = [...new Set(PL_RULES.map((r) => r.group))];
  return (
    <div className="rulechain">
      {rules.map((r, i) => (
        <Popover key={i} label={`Edit rule ${ruleText(r)}`} button={<span className={`rulechip${r.off ? " off" : ""}`}>{i + 1}. {ruleText(r)}</span>}>
          {(close) => <RuleEditor r={r} set={(n) => onChange(rules.map((x, k) => (k === i ? n : x)))} del={() => (close(), onChange(rules.filter((_, k) => k !== i)))} mv={(d) => onChange(move(rules, i, d))} openExpr={() => (close(), openExpr(i))} />}
        </Popover>
      ))}
      <select aria-label="Add rule" className="addrule" value="" onChange={(e) => {
        const op = e.target.value as PlRuleOp;
        if (!op) return;
        const d = ruleDef(op)!;
        const r: PlRule = { op };
        for (const p of d.params) if (p.kind === "select") r[p.key] = p.options![0][0];
        onChange([...rules, r]);
        if (op === "expr" || op === "code") openExpr(rules.length);
      }}>
        <option value="">+ rule</option>
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {PL_RULES.filter((r) => r.group === g).map((r) => <option key={r.op} value={r.op} title={r.help}>{r.label}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function RuleEditor({ r, set, del, mv, openExpr }: { r: PlRule; set: (r: PlRule) => void; del: () => void; mv: (d: -1 | 1) => void; openExpr: () => void }) {
  const d = ruleDef(r.op);
  return (
    <div className="ruleed">
      <div className="head"><b>{d?.label}</b><span className="muted">{d?.help}</span></div>
      {d?.params.map((p) => (
        <label key={p.key} className="f">
          {p.label}
          {p.kind === "select" ? (
            <select value={r[p.key] ?? ""} onChange={(e) => set({ ...r, [p.key]: e.target.value })}>{p.options!.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          ) : p.kind === "check" ? (
            <input type="checkbox" checked={r[p.key] === "1"} onChange={(e) => set({ ...r, [p.key]: e.target.checked ? "1" : "" })} />
          ) : p.kind === "expr" || p.kind === "code" ? (
            <>
              <textarea rows={p.kind === "code" ? 6 : 3} value={r[p.key] ?? ""} placeholder={p.ph} onChange={(e) => set({ ...r, [p.key]: e.target.value })} style={{ fontFamily: "var(--f-mono)", fontSize: 12 }} spellCheck={false} />
              <button type="button" className="btn-primary" onClick={openExpr}>Open expression builder…</button>
            </>
          ) : p.kind === "lines" ? (
            <textarea rows={6} value={r[p.key] ?? ""} placeholder={p.ph} onChange={(e) => set({ ...r, [p.key]: e.target.value })} style={{ fontFamily: "var(--f-mono)", fontSize: 12 }} />
          ) : (
            <input type="text" value={r[p.key] ?? ""} placeholder={p.ph} onChange={(e) => set({ ...r, [p.key]: e.target.value })} />
          )}
        </label>
      ))}
      {!!d?.examples?.length && (
        <div className="ruleex">
          <b>Examples</b>
          {d.examples.map((ex, k) => (
            <div key={k} className="ex">
              <span className="muted">{k + 1}. {ex.note}</span>
              <code>{ex.in === "" ? "(empty)" : ex.in} → {ruleExample(r.op, ex).out}</code>
              <span className="muted mono">{Object.entries(ex.r).map(([p, v]) => `${d.params.find((x) => x.key === p)?.label ?? p}: ${String(v).replace(/\n/g, " ⏎ ")}`).join(" · ")}{ex.cols ? ` · columns ${Object.entries(ex.cols).map(([h, v]) => `${h}=${v}`).join(", ")}` : ""}{ex.n && ex.n !== 1 ? ` · {n}=${ex.n}` : ""}{ex.row ? ` · row ${ex.row}` : ""}</span>
              <button type="button" className="btn-ghost" onClick={() => set({ op: r.op, ...ex.r, off: r.off })}>Use</button>
            </div>
          ))}
        </div>
      )}
      <div className="toolbar sub">
        <label className="ctl"><input type="checkbox" checked={!r.off} onChange={(e) => set({ ...r, off: !e.target.checked })} /> Enabled</label>
        <span className="grow" />
        <button type="button" onClick={() => mv(-1)}>← Earlier</button>
        <button type="button" onClick={() => mv(1)}>Later →</button>
        <button type="button" className="btn-danger" onClick={del}>Remove</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Expression builder

export type Snip = [code: string, help: string];
export const PY_SNIPPETS: [string, Snip[]][] = [
  ["Text", [
    ['value', "Current value of this column (before this rule)"],
    ['f"{value}_{n:02d}"', "f-string: text with {expressions} and format specs"],
    ['a + "_" + b', "Join text (both sides must be text: str(x) converts)"],
    ['value.upper()', "UPPER CASE"], ['value.lower()', "lower case"], ['value.title()', "Title Case"],
    ['value.strip()', "Remove surrounding spaces"],
    ['value.replace("old", "new")', "Replace text"],
    ['value.zfill(4)', "Pad with zeros on the left: 14 → 0014"],
    ['value.rjust(6, "_")', "Right-align to a width with a fill character"],
    ['value[0:3]', "Characters 0 to 2 (slice)"], ['value[-3:]', "Last 3 characters"],
    ['value.split("_")[0]', "Part before the first _"],
    ['"_".join([a, b, c])', "Join several values with _"],
    ['len(value)', "Number of characters"],
    ['value.startswith("V")', "True if it starts with V"],
  ]],
  ["Numbers", [
    ['int(value)', "Text → whole number"], ['float(value)', "Text → decimal number"], ['str(x)', "Number → text"],
    ['int(value, 16)', "Hex text → number"], ['hex(x)', "Number → 0x… text"],
    ['round(x, 2)', "Round to 2 decimals"], ['abs(x)', "Absolute value"], ['min(a, b)', "Smaller of two"], ['max(a, b)', "Larger of two"],
    ['a // b', "Whole-number division"], ['a % b', "Remainder"], ['a ** 2', "Power"],
  ]],
  ["Format", [
    ['f"{x:04d}"', "Whole number, 4 digits with zeros"], ['f"{x:.2f}"', "2 decimals"], ['f"{x:>8}"', "Right-aligned in 8 characters"],
    ['f"{x:X}"', "Hexadecimal"], ['f"{x:,}"', "Thousands separator"], ['format(x, "05.1f")', "Same specs as a function"],
  ]],
  ["Logic", [
    ['a if condition else b', "Choose a value"], ['x == "W"', "Equal"], ['x != ""', "Not equal / not empty"],
    ['"RW" in value', "Contains"], ['a and b', "Both true"], ['a or b', "Either true; also a fallback: value or \"n/a\""], ['not a', "Negation"],
    ['x is None', "Is empty (None)"], ['isinstance(x, str)', "Type check (str, int, float, list, dict)"],
  ]],
  ["Code (Python code mode)", [
    ['x = value.split("_")', "Assign a variable"],
    ['if x == "W":\n    return "RW"\nreturn "R"', "if / else with return"],
    ['for p in parts:\n    if p.isdigit():\n        return p', "Loop and return the first match"],
    ['parts = [p.strip() for p in value.split(",")]', "List comprehension"],
    ['d = {"A": 1, "B": 2}\nreturn d.get(value, 0)', "Dictionary lookup with a default"],
    ['print(value)', "Show a value in the preview log"],
    ['try:\n    num = float(x)\nexcept ValueError:\n    num = None', "Catch an error (try / except)"],
    ['while i < 10:\n    i += 1', "while loop"],
    ['for p in parts:\n    if p:\n        break\nelse:\n    p = None', "Loop with else (no break)"],
    ['raise ValueError("bad value")', "Stop with an error"],
    ['def half(v):\n    return v / 2', "Local helper function"],
    ['num.is_integer()', "Float has no fraction"],
  ]],
  ["Helpers", [
    ['pad(x, 4)', "Pad any value with 0 on the left to 4 characters"], ['pad(x, 6, " ")', "Pad with another character"],
    ['modicon(result.space, result.address)', "HR 14 → 40015"],
    ['n', "Array instance number"], ['i', "Instance counted from 0"], ['row', "Row number within the table"],
  ]],
];

/** Popup editor for an Expression (Python) rule with drag-and-drop syntax, table columns and result values. */
function ExpressionBuilder({ b, t, colId, idx, grids, extra, libs, libItems, refreshLibs, onLibs, onApply, onClose }: {
  extra: ReturnType<typeof mergeLibs>["names"]; libs: ReturnType<typeof mergeLibs>["libs"];
  libItems: Versioned[]; refreshLibs: () => unknown; onLibs: (r: LibRef[]) => void;
  b: PlBuild; t: PlTable; colId: string; idx: number; grids: Record<string, Grid | null>; onApply: (src: string, op: "expr" | "code") => void; onClose: () => void;
}) {
  const col = t.columns.find((c) => c.id === colId)!;
  const [src, setSrc] = useState(col.rules[idx]?.a ?? "");
  const [mode, setMode] = useState<"expr" | "code">(col.rules[idx]?.op === "code" ? "code" : "expr");
  const [tab, setTab] = useState<"py" | "cols" | "result" | "fn">("py");
  const ta = useRef<HTMLTextAreaElement>(null);
  const headers = tableInput(t, grids[t.slot]).headers.filter(Boolean);
  const q = (x: string) => JSON.stringify(x);
  const insert = (code: string) => {
    const el = ta.current;
    if (!el) return setSrc((x) => x + code);
    const a = el.selectionStart ?? src.length;
    const z = el.selectionEnd ?? a;
    setSrc(src.slice(0, a) + code + src.slice(z));
    caret.current = a + code.length;
  };
  // Put the caret after inserted text as soon as the new text is rendered.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current == null || !ta.current) return;
    ta.current.focus();
    ta.current.selectionStart = ta.current.selectionEnd = caret.current;
    caret.current = null;
  });
  let err = "";
  try {
    if (src.trim()) (mode === "code" ? parseCode(src) : parseExpr(src));
  } catch (e) {
    err = (e as Error).message;
  }
  const names = mode === "code" ? codeNames(src) : exprNames(src);
  const late = isLateRule({ op: mode, a: src });
  const key = colKey(col);
  const preview = useMemo(() => {
    if (err || !src.trim()) return null;
    const tt: PlTable = { ...t, columns: t.columns.map((c) => (c.id === colId ? { ...c, rules: c.rules.map((r, k) => (k === idx ? { ...r, op: mode, a: src } : r)) } : c)) };
    const r = runBuild({ ...b, tables: b.tables.map((x) => (x.id === t.id ? tt : x)) }, grids, { extra });
    return r.points.map((p, i) => ({ p, i })).filter(({ p }) => p.table === t.id && !p.reserved).slice(0, 8).map(({ p }) => ({
      tag: p.v.tag ?? "", val: p.v[key] ?? "", addr: p.addr, space: p.space, iss: p.issues.map((k) => r.issues[k]).filter((x) => x.field === key).map((x) => x.msg),
    }));
  }, [src, err, b, t, colId, idx, grids, key, mode, extra]);
  const Chip = ({ code, help, onPick }: { code: string; help: string; onPick?: () => void }) => (
    <button type="button" draggable className="snip" title={help} onDragStart={(e) => (e.dataTransfer.setData("text/plain", code), onPick?.())} onClick={() => (onPick?.(), insert(code))}>
      <code>{code}</code><span>{help}</span>
    </button>
  );
  return (
    <Modal onClose={onClose} label="Expression builder">
      <div className="exprmodal">
        <div className="mh"><h3>Expression builder · {colLabel(col, b.protocol)}</h3>
          <Seg<"expr" | "code"> label="Mode" value={mode} onChange={setMode} options={[["expr", "Expression"], ["code", "Python code"]]} />
          <span className="muted">{mode === "code" ? "Several lines; return the new value" : "One Python expression"} · rule {idx + 1} of this column</span></div>
        <div className="mb">
          <div className="exprgrid">
            <section>
              <label className="f">Expression — drag items from the right, or click to insert at the cursor
                <textarea ref={ta} rows={mode === "code" ? 12 : 6} aria-label="Expression" value={src} spellCheck={false} onChange={(e) => setSrc(e.target.value)} className="exprsrc" placeholder={'f"{col[\'Register Type\']}_{result.address:04d}_{out[\'Source_Device\']}_{unit.desired}"'} />
              </label>
              <div className="toolbar sub">
                {err ? <span className="chip err">Syntax: {err}</span> : src.trim() ? <span className="chip info">Syntax OK</span> : <span className="muted">Empty</span>}
                {!err && src.trim() && <span className="muted">{late ? "Evaluated in the Result (uses " + ["result", "unit", "series"].filter((x) => names.has(x)).join(", ") + ")" : "Evaluated while conditioning"}{names.has("out") ? " · out[…] of a column computed later is filled in the Result" : ""}</span>}
              </div>
              <div className="head"><h3>Preview</h3><span className="muted">First points of this table in the Result</span></div>
              <table className="vt exprprev">
                <thead><tr><th>Space</th><th>Address</th>{key !== "tag" && <th>Tag</th>}<th>{colLabel(col, b.protocol)}</th></tr></thead>
                <tbody>
                  {preview?.map((r, k) => (
                    <tr key={k} className={r.iss.length ? "bad" : undefined} title={r.iss.join("\n") || undefined}>
                      <td>{r.space}</td><td className="mono">{r.addr ?? ""}</td>{key !== "tag" && <td className="mono">{r.tag}</td>}<td className="mono">{r.val}{r.iss.length ? <div className="chip err">{r.iss[0]}</div> : null}</td>
                    </tr>
                  ))}
                  {!preview?.length && <tr><td colSpan={4} className="muted">{err ? "Fix the syntax to see a preview." : "No points yet (needs an input and a placement of this table)."}</td></tr>}
                </tbody>
              </table>
            </section>
            <section className="exprpal">
              <Seg<"py" | "cols" | "result" | "fn"> label="Expression items" value={tab} onChange={setTab} options={[["py", "Python syntax"], ["cols", "Table columns"], ["result", "Result columns"], ["fn", `Functions${libs.length ? ` (${libs.flatMap((l) => l.funcs).length})` : ""}`]]} />
              <div className="snips">
                {tab === "py" && PY_SNIPPETS.map(([g, l]) => (
                  <div key={g}><h4>{g}</h4>{l.map(([c, h]) => <Chip key={c} code={c} help={h} />)}</div>
                ))}
                {tab === "cols" && (
                  <>
                    <div><h4>Input columns · {b.slots.find((x) => x.id === t.slot)?.name ?? "input"}</h4>
                      {headers.map((h) => <Chip key={h} code={`col[${q(h)}]`} help={`Input column “${h}” (text)`} />)}
                      {!headers.length && <span className="muted">The input has no data.</span>}
                    </div>
                    <div><h4>Output columns of {t.name}</h4>
                      {t.columns.filter((c) => c.id !== colId).map((c) => <Chip key={c.id} code={`out[${q(colLabel(c, b.protocol))}]`} help={`${c.field ? "Protocol data" : "Informative"} column (text, value after its rules)`} />)}
                      {t.units?.on && <><Chip code={'out["Scaled-Unit"]'} help="Desired unit (units applied)" /><Chip code={'out["Unit-Scaling"]'} help="Unit-Scaling factor" /></>}
                    </div>
                    <div><h4>Row</h4>{([["value", "Value of this column before this rule"], ["n", "Array instance number"], ["i", "Instance counted from 0"], ["row", "Row number within the table"]] as Snip[]).map(([c, h]) => <Chip key={c} code={c} help={h} />)}</div>
                  </>
                )}
                {tab === "fn" && <FunctionsPalette refs={b.libs ?? []} onRefs={onLibs} items={libItems} libs={libs} Chip={Chip} onRefresh={refreshLibs} where="this build" />}
                {tab === "result" && (
                  <>
                    <div><h4>Result (after placement)</h4>{RESULT_TOKENS.map(([k, d]) => <Chip key={k} code={`result.${k}`} help={d} />)}</div>
                    <div><h4>Units</h4>{UNIT_TOKENS.map(([k, d]) => <Chip key={k} code={`unit.${k}`} help={d} />)}</div>
                    <div><h4>Series</h4>
                      {(b.series ?? []).map((x) => <Chip key={x.id} code={`series[${q(x.name)}]`} help={`Next number of ${x.name} (${fmtSeries(x.start, x.format)}, …)`} />)}
                      {!(b.series ?? []).length && <span className="muted">No series defined (Series…).</span>}
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>
        </div>
        <div className="mf"><span className="info">result.*, unit.* and series[…] are available in the Result only; the Tables preview shows {"{=…}"} until then.</span><button type="button" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!!err} onClick={() => onApply(src, mode)}>Apply</button></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Data types

const BITS_LABEL: Record<PlDtBits, string> = { "16": "16-bit", "32": "32-bit", "64": "64-bit", other: "All other" };
const dtCsv = (set: PlDtSet) => ["Name;Alias;Content size (registers);Family;Size", ...set.types.map((t) => [t.name, t.alias, t.registers, t.family, t.bits].join(";"))].join("\n");

/** Map the raw data types of a table onto the build's standard (protocol independent) data type set. */
function DataTypesModal({ table, set, raws, hasCol, onSet, onMap, onClose }: {
  table: PlTable; set: PlDtSet; raws: string[]; hasCol: boolean;
  onSet: (s: PlDtSet) => void; onMap: (m: NonNullable<PlTable["dtMap"]>) => void; onClose: () => void;
}) {
  const ui = useUi();
  const dm = table.dtMap ?? { on: false, map: {} };
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [imp, setImp] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const counts = new Map<string, { raw: string; n: number }>();
  for (const r of raws) {
    const k = r.toLowerCase();
    const c = counts.get(k) ?? { raw: r, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  const list = [...counts.entries()].sort((a, b) => a[1].raw.localeCompare(b[1].raw, undefined, { numeric: true }));
  const byName = new Map(set.types.map((x) => [x.name, x]));
  const assign = (k: string, name: string | null) => {
    const map = { ...dm.map };
    if (name) map[k] = name;
    else delete map[k];
    onMap({ ...dm, on: dm.on || !!name, map });
  };
  const pick = (name: string) => {
    if (!sel) return ui.toast("Select a raw data type on the left first, or drag the type onto it");
    assign(sel, name);
    const next = list.find(([k]) => k !== sel && !dm.map[k]);
    setSel(next ? next[0] : null);
  };
  const fams = PL_DT_FAMILIES.filter((f) => set.types.some((x) => x.family === f));
  const setType = (i: number, p: Partial<PlStdType>) => onSet({ ...set, types: set.types.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  const mapped = list.filter(([k]) => dm.map[k]).length;
  return (
    <Modal onClose={onClose} label="Data types">
      <div className="dtmodal">
        <div className="mh"><h3>Data types · {table.name}</h3>
          <label className="ctl"><input type="checkbox" checked={dm.on} onChange={(e) => onMap({ ...dm, on: e.target.checked })} /> Apply mapping to this table</label>
        </div>
        <div className="mb">
          <div className="toolbar sub">
            <label className="ctl">Standard set <input type="text" aria-label="Data type set name" value={set.name} onChange={(e) => onSet({ ...set, name: e.target.value })} style={{ width: 130 }} /></label>
            <span className="muted">Protocol independent · shared by every table of this build</span>
            <span className="grow" />
            <VersionBar<PlDtSet>
              storageKey="fpl.plb.dtypes"
              store={api.dtypeSets}
              noun="data type set"
              defaultName={set.name.replace(/\s+/g, "") || "DataTypes"}
              data={set}
              canon={stableJson}
              restore={async (d) => onSet({ ...defaultDtSet(), ...d })}
              describe={(d) => ({ types: d.types.length, rows: d.types.length, cols: 5 })}
            />
          </div>
          <div className="dtgrid">
            <section>
              <div className="head"><h3>In this table</h3><span className="muted">{hasCol ? `${list.length} raw data type${list.length === 1 ? "" : "s"} · ${mapped} mapped` : "No column is allocated to Data type"}</span>
                <span className="grow" />
                <button type="button" disabled={!list.length} title="Match by name or alias, then common spellings (uint16 → U16, float32 → FLT (BE))" onClick={() => {
                  const m = autoMatchTypes(list.map(([, c]) => c.raw), set);
                  onMap({ ...dm, on: true, map: { ...m, ...dm.map } });
                  ui.toast(`Matched ${Object.keys(m).filter((k) => !dm.map[k]).length} new`);
                }}>Auto-match</button>
                <HoldButton label="Clear all mappings" onHold={() => onMap({ ...dm, map: {} })}>Clear</HoldButton>
              </div>
              <table className="vt dtmap">
                <thead><tr><th>Raw data type</th><th>Rows</th><th>Standard data type</th><th>Size</th></tr></thead>
                <tbody>
                  {list.map(([k, c]) => {
                    const std = dm.map[k] ? byName.get(dm.map[k]) : undefined;
                    return (
                      <tr key={k} className={[sel === k && "sel", over === k && "over"].filter(Boolean).join(" ") || undefined} onClick={() => setSel(k)}
                        onDragOver={(e) => (e.preventDefault(), setOver(k))} onDragLeave={() => setOver(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setOver(null);
                          const n = e.dataTransfer.getData("text/plain");
                          if (n) assign(k, n);
                        }}>
                        <td className="mono">{c.raw}</td>
                        <td className="mono">{c.n}</td>
                        <td className="drop" aria-label={`Standard data type for ${c.raw}`}>
                          {dm.map[k] ? (
                            <span className={`dtchip f-${std?.family ?? "Other"}`}>{dm.map[k]}<button type="button" className="btn-ghost" aria-label={`Clear ${c.raw}`} onClick={(e) => (e.stopPropagation(), assign(k, null))}>✕</button></span>
                          ) : <span className="muted">drop a type here</span>}
                        </td>
                        <td className="mono">{std ? `${std.bits === "other" ? "" : std.bits + "-bit"}${std.registers ? ` · ${std.registers} reg` : ""}` : ""}</td>
                      </tr>
                    );
                  })}
                  {!list.length && <tr><td colSpan={4} className="muted">{hasCol ? "The Data type column is empty in every row." : "Allocate a column to Data type (Protocol data) first."}</td></tr>}
                </tbody>
              </table>
            </section>
            <section>
              <div className="head"><h3>Standard data types · {set.name}</h3><span className="muted">{set.types.length} types · drag onto a raw type, or select a raw type and click</span>
                <span className="grow" />
                <button type="button" className={edit ? "on" : undefined} onClick={() => setEdit(!edit)}>{edit ? "Done editing" : "Edit set"}</button>
              </div>
              {!edit ? (
                <div className="dtpal-wrap"><table className="vt dtpalette">
                  <thead><tr><th />{fams.map((f) => <th key={f}>{f}</th>)}</tr></thead>
                  <tbody>
                    {PL_DT_BITS.map(([bits]) => (
                      <tr key={bits}>
                        <th>{BITS_LABEL[bits]}</th>
                        {fams.map((f) => (
                          <td key={f}>
                            {set.types.filter((x) => x.family === f && x.bits === bits).map((x) => (
                              <button key={x.name} type="button" draggable className={`dtchip f-${x.family}`} title={`${x.name}${x.alias ? ` · alias ${x.alias}` : ""} · ${x.registers ? `${x.registers} register(s)` : "no fixed size"}`}
                                onDragStart={(e) => e.dataTransfer.setData("text/plain", x.name)} onClick={() => pick(x.name)}>{x.name}</button>
                            ))}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              ) : (
                <>
                  <table className="vt dtedit">
                    <thead><tr><th>Name</th><th>Alias</th><th>Family</th><th>Size</th><th title="Registers; Modbus TCP and serial only">Content size</th><th /></tr></thead>
                    <tbody>
                      {set.types.map((x, i) => (
                        <tr key={i}>
                          <td><input type="text" aria-label={`Type ${i + 1} name`} value={x.name} onChange={(e) => setType(i, { name: e.target.value })} /></td>
                          <td><input type="text" aria-label={`Type ${i + 1} alias`} value={x.alias} onChange={(e) => setType(i, { alias: e.target.value })} /></td>
                          <td><select aria-label={`Type ${i + 1} family`} value={x.family} onChange={(e) => setType(i, { family: e.target.value as PlDtFamily })}>{PL_DT_FAMILIES.map((f) => <option key={f}>{f}</option>)}</select></td>
                          <td><select aria-label={`Type ${i + 1} size`} value={x.bits} onChange={(e) => setType(i, { bits: e.target.value as PlDtBits })}>{PL_DT_BITS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                          <td><input type="text" aria-label={`Type ${i + 1} content size`} value={x.registers} placeholder="—" onChange={(e) => setType(i, { registers: e.target.value.replace(/[^0-9]/g, "") })} style={{ width: 60 }} /></td>
                          <td><HoldButton label={`Delete ${x.name}`} onHold={() => onSet({ ...set, types: set.types.filter((_, k) => k !== i) })}>✕</HoldButton></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="toolbar sub">
                    <button type="button" onClick={() => onSet({ ...set, types: [...set.types, inferStdType(`TYPE_${set.types.length + 1}`)] })}>+ Type</button>
                    <button type="button" onClick={async () => (await ui.confirm("Replace the set with the default EMS-SC types?", "Reset")) && onSet(defaultDtSet())}>Defaults</button>
                  </div>
                </>
              )}
              <div className="toolbar sub">
                <button type="button" className="btn-primary" onClick={() => setImp("")}>Bulk import…</button>
                <button type="button" onClick={() => download(`${set.name || "datatypes"}.csv`, dtCsv(set), "text/csv")}>Export CSV</button>
                <button type="button" onClick={() => download(`${set.name || "datatypes"}.json`, JSON.stringify(set, null, 2), "application/json")}>Export JSON</button>
              </div>
              {imp != null && (
                <div className="card">
                  <label className="f">One type per line: Name [, Alias] [, Content size] [, Family] [, Size 16/32/64/other] — tab or ; separated (a header row is skipped). Missing family, size and content size are inferred from the name (U32 (LE) → Unsigned, 32-bit, 2 registers). A JSON export can be pasted too.
                    <textarea rows={8} aria-label="Data types to import" value={imp} onChange={(e) => setImp(e.target.value)} style={{ fontFamily: "var(--f-mono)", fontSize: 12 }} placeholder={"U16\nI16\nU32 (LE)\nFLT (BE)\nUTF8 (BE)"} />
                  </label>
                  <div className="toolbar sub">
                    <label className="btn">Open file…<input type="file" accept=".csv,.txt,.tsv,.json" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) setImp(await f.text());
                    }} /></label>
                    <span className="grow" />
                    <button type="button" onClick={() => setImp(null)}>Cancel</button>
                    {(["append", "replace"] as const).map((how) => (
                      <button key={how} type="button" className={how === "replace" ? "btn-primary" : undefined} onClick={() => {
                        let types: PlStdType[] = [];
                        const txt = imp.trim();
                        if (txt.startsWith("{") || txt.startsWith("[")) {
                          try {
                            const j = JSON.parse(txt);
                            types = (Array.isArray(j) ? j : j.types ?? []).map((x: Partial<PlStdType>) => ({ ...inferStdType(String(x.name ?? ""), String(x.alias ?? "")), ...x }));
                          } catch {
                            return ui.toast("Invalid JSON");
                          }
                        } else types = parseDtTypes(txt);
                        if (!types.length) return ui.toast("Nothing to import");
                        const keep = how === "append" ? set.types.filter((x) => !types.some((y) => y.name.toLowerCase() === x.name.toLowerCase())) : [];
                        onSet({ ...set, types: [...keep, ...types] });
                        setImp(null);
                        ui.toast(`${how === "append" ? "Added" : "Imported"} ${types.length} data types`);
                      }}>{how === "append" ? "Add to set" : "Replace set"}</button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
        <div className="mf"><span className="info">Content size (registers) applies to Modbus TCP and serial only. Mapped types replace the Data type column; unmapped ones are reported in the Result.</span><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Series

/** Named counters for dynamic aliases: {series:Name} takes the next number each time it is placed in a row. */
function SeriesModal({ series, onChange, onClose }: { series: PlSeries[]; onChange: (s: PlSeries[]) => void; onClose: () => void }) {
  const set = (i: number, p: Partial<PlSeries>) => onChange(series.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const int = (v: string) => (Number.isFinite(+v) ? Math.trunc(+v) : 0);
  return (
    <Modal onClose={onClose} label="Series">
      <div className="mh"><h3>Series</h3><span className="muted">Shared by every table of this build</span></div>
      <div className="mb">
        <p className="muted" style={{ margin: 0 }}>
          Write <code>{"{series:Name}"}</code> in any rule text (e.g. Set value <code>{"RACK{series:Rack}_SOC"}</code>). In the Result, every row that uses it gets the next number, in placement order; using the series several times in the same row (register) repeats the same number. Format: zeros mark the digits (<code>0000</code> → 0032), <code>#</code> means no padding, other text is kept (<code>RK-00</code> → RK-07).
        </p>
        <table className="vt series">
          <thead><tr><th>Name</th><th>Start number</th><th>Increment</th><th>Format</th><th>Syntax</th><th>First values</th><th /></tr></thead>
          <tbody>
            {series.map((x, i) => (
              <tr key={x.id}>
                <td><input type="text" aria-label={`Series ${i + 1} name`} value={x.name} onChange={(e) => set(i, { name: e.target.value.replace(/[{}]/g, "") })} /></td>
                <td><input type="number" aria-label={`Series ${i + 1} start`} value={x.start} onChange={(e) => set(i, { start: int(e.target.value) })} style={{ width: 80 }} /></td>
                <td><input type="number" aria-label={`Series ${i + 1} increment`} value={x.step} onChange={(e) => set(i, { step: int(e.target.value) })} style={{ width: 70 }} /></td>
                <td><input type="text" aria-label={`Series ${i + 1} format`} value={x.format} placeholder="0000" onChange={(e) => set(i, { format: e.target.value })} style={{ width: 100 }} /></td>
                <td><code>{`{series:${x.name}}`}</code></td>
                <td className="mono">{[0, 1, 2].map((k) => fmtSeries(x.start + k * x.step, x.format)).join(", ")}…</td>
                <td><HoldButton label={`Delete series ${x.name}`} onHold={() => onChange(series.filter((_, k) => k !== i))}>✕</HoldButton></td>
              </tr>
            ))}
            {!series.length && <tr><td colSpan={7} className="muted">No series yet.</td></tr>}
          </tbody>
        </table>
        <div className="toolbar sub">
          <button type="button" onClick={() => onChange([...series, { id: uid(), name: `Series${series.length + 1}`, start: 1, step: 1, format: "0000" }])}>+ Series</button>
        </div>
      </div>
      <div className="mf"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Placements / arrays

const PALETTE = ["#0b6e69", "#1d5fa8", "#9a5800", "#7a3e9d", "#b3261e", "#1f6b3a", "#5b6872", "#b0490f"];

function ArraysTab({ b, setB, result }: { b: PlBuild; setB: SetB; result: ReturnType<typeof runBuild> }) {
  const setP = (p: PlPlacement) => setB((x) => ({ ...x, placements: x.placements.map((y) => (y.id === p.id ? p : y)) }));
  const add = (table: string) => {
    const t = b.tables.find((x) => x.id === table);
    if (!t) return;
    setB({ ...b, placements: [...b.placements, { id: uid(), name: `${t.name} ×4`, table, count: 4, mode: "last", start: 0, stride: 0, gap: 0, nStart: 1 }] });
  };
  const color = (id: string) => PALETTE[b.placements.findIndex((p) => p.id === id) % PALETTE.length];
  const spaces = [...new Set(result.blocks.map((x) => x.space))].sort();
  const num = (v: string) => (Number.isFinite(+v) ? Math.floor(+v) : 0);
  return (
    <main className="plb-one">
      <section className="pane" aria-label="Placements">
        <div className="pane-head">
          <h2>Placements & arrays</h2>
          <span className="hint">Placed in this order. Count 1 places a table once; more repeats the whole conditioned table as blocks.</span>
          <select aria-label="Add placement" value="" onChange={(e) => add(e.target.value)} disabled={!b.tables.length}>
            <option value="">+ Array of table…</option>
            {b.tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="scroll">
          <table className="vt plb-pl">
            <thead>
              <tr><th /><th>Name</th><th>Table</th><th title="Repetitions">Count</th><th>Offset from</th><th title="Register of instance 1 (From register 0), or where the search starts (Into free registers)">Start</th><th title="Registers between instance starts (0 = block size)">Stride</th><th title="Free registers before the first block (From last known register)">Gap</th><th title="{n} of the first instance">{"{n}"} from</th><th>Blocks</th><th /></tr>
            </thead>
            <tbody>
              {b.placements.map((p, i) => {
                const bl = result.blocks.filter((x) => x.placement === p.id);
                return (
                  <tr key={p.id} className={p.off ? "off" : undefined}>
                    <td><input type="checkbox" aria-label="Enabled" checked={!p.off} onChange={(e) => setP({ ...p, off: !e.target.checked })} /> <i className="sw" style={{ background: color(p.id) }} /></td>
                    <td><input type="text" aria-label="Placement name" value={p.name} placeholder={b.tables.find((t) => t.id === p.table)?.name} onChange={(e) => setP({ ...p, name: e.target.value })} style={{ width: 150 }} /></td>
                    <td>
                      <select aria-label="Table" value={p.table} onChange={(e) => setP({ ...p, table: e.target.value })}>
                        {b.tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td><input type="number" aria-label="Count" min={1} value={p.count} onChange={(e) => setP({ ...p, count: Math.max(1, num(e.target.value)) })} style={{ width: 64 }} /></td>
                    <td>
                      <select aria-label="Offset mode" value={p.mode} onChange={(e) => setP({ ...p, mode: e.target.value as PlMode })}>
                        {PL_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </td>
                    <td><input type="number" aria-label="Start register" min={0} disabled={p.mode !== "zero" && p.mode !== "free"} value={p.start} onChange={(e) => setP({ ...p, start: Math.max(0, num(e.target.value)) })} style={{ width: 80 }} /></td>
                    <td title={b.tables.find((x) => x.id === p.table)?.validated ? `Validated block size: ${b.tables.find((x) => x.id === p.table)!.validated!.span}` : "0 = block size; Validate the table to fill this in"}><input type="number" aria-label="Stride" min={0} value={p.stride} onChange={(e) => setP({ ...p, stride: Math.max(0, num(e.target.value)) })} style={{ width: 70 }} /></td>
                    <td><input type="number" aria-label="Gap" min={0} disabled={p.mode !== "last"} value={p.gap} onChange={(e) => setP({ ...p, gap: Math.max(0, num(e.target.value)) })} style={{ width: 60 }} /></td>
                    <td><input type="number" aria-label="First instance number" value={p.nStart} onChange={(e) => setP({ ...p, nStart: num(e.target.value) })} style={{ width: 56 }} /></td>
                    <td className="ts" title={blockSummary(bl)}>{bl.length ? `${plural(bl.length, "block")} · ${blockSummary(bl.slice(0, 2))}${bl.length > 2 ? " …" : ""}` : "—"}</td>
                    <td className="nowrap">
                      <button type="button" className="btn-ghost" aria-label="Move up" onClick={() => setB({ ...b, placements: move(b.placements, i, -1) })}>↑</button>
                      <button type="button" className="btn-ghost" aria-label="Move down" onClick={() => setB({ ...b, placements: move(b.placements, i, 1) })}>↓</button>
                      <HoldButton label={`Delete placement ${p.name}`} onHold={() => setB({ ...b, placements: b.placements.filter((x) => x.id !== p.id) })}>✕</HoldButton>
                    </td>
                  </tr>
                );
              })}
              {!b.placements.length && <tr><td colSpan={11} className="muted">No placements. Each new table is placed once; add arrays with “+ Array of table…”.</td></tr>}
            </tbody>
          </table>

          {spaces.map((sp) => {
            const bl = result.blocks.filter((x) => x.space === sp).sort((x, y) => x.start - y.start);
            const lo = Math.min(...bl.map((x) => x.start));
            const hi = Math.max(...bl.map((x) => x.end));
            const span = Math.max(1, hi - lo + 1);
            return (
              <div className="card" key={sp}>
                <div className="head"><h3>{sp}</h3><span className="muted">{lo}–{hi} · {plural(bl.length, "block")} · {bl.reduce((n, x) => n + x.points, 0)} points</span></div>
                <div className="blockbar" role="img" aria-label={`${sp} block map`}>
                  {bl.map((x, k) => {
                    const ov = bl.some((y, j) => j !== k && y.start <= x.end && x.start <= y.end);
                    return (
                      <span key={k} className={ov ? "ov" : undefined} title={`${x.name} #${x.inst}: ${x.start}–${x.end} (${x.points} points)${ov ? " · overlaps another block" : ""}`}
                        style={{ left: `${((x.start - lo) / span) * 100}%`, width: `max(2px, ${((x.end - x.start + 1) / span) * 100}%)`, background: color(x.placement) }} />
                    );
                  })}
                </div>
                <table className="vt">
                  <thead><tr><th>Block</th><th>Start</th><th>End</th><th>Size</th><th>Points</th><th /></tr></thead>
                  <tbody>
                    {bl.map((x, k) => {
                      const ov = bl.some((y, j) => j !== k && y.start <= x.end && x.start <= y.end);
                      return (
                        <tr key={k} className={ov ? "bad" : undefined}>
                          <td><i className="sw" style={{ background: color(x.placement) }} /> {x.name} #{x.inst}</td>
                          <td className="mono">{x.start}</td>
                          <td className="mono">{x.end}</td>
                          <td className="mono">{x.end - x.start + 1}</td>
                          <td className="mono">{x.points}</td>
                          <td>{ov && <span className="chip err">overlap</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- Result

const KIND_LABEL: Record<PlIssue["kind"], string> = {
  overlap: "Overlapping registers", range: "Out of range", address: "Address", tag: "Tag", type: "Type / size", access: "Access", rule: "Rule warnings", space: "Register / point type", config: "Build",
};

function ResultTab({ b, result }: { b: PlBuild; result: ReturnType<typeof runBuild> }) {
  const [show, setShow] = useState<"all" | "issues" | "errors">("all");
  const [kind, setKind] = useState<PlIssue["kind"] | "">("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const cols = resultColumns(b);
  const names = new Map(b.placements.map((p) => [p.id, p.name || b.tables.find((t) => t.id === p.table)?.name || ""]));
  const kinds = Object.entries(
    result.issues.reduce<Record<string, { e: number; w: number }>>((m, i) => {
      const k = (m[i.kind] ??= { e: 0, w: 0 });
      if (i.level === "error") k.e++;
      else k.w++;
      return m;
    }, {}),
  ) as [PlIssue["kind"], { e: number; w: number }][];
  const ql = q.trim().toLowerCase();
  const list = result.points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => {
      const iss = p.issues.map((k) => result.issues[k]);
      if (show === "issues" && !iss.length) return false;
      if (show === "errors" && !iss.some((x) => x.level === "error")) return false;
      if (kind && !iss.some((x) => x.kind === kind)) return false;
      if (ql && !Object.values(p.v).some((v) => v.toLowerCase().includes(ql))) return false;
      return true;
    });
  useEffect(() => setPage(0), [show, kind, q]);
  const PAGE = 500;
  const general = result.issues.filter((i) => i.point == null);
  return (
    <main className="plb-one">
      <section className="pane" aria-label="Result">
        <div className="pane-head">
          <h2>Source table</h2>
          <Seg label="Rows" value={show} onChange={setShow} options={[["all", `All (${result.points.length})`], ["issues", "With issues"], ["errors", "With errors"]]} />
          <input type="search" aria-label="Search points" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="bubbles" role="group" aria-label="Issue types">
            {kinds.map(([k, n]) => (
              <button key={k} type="button" className="bubble" aria-pressed={kind === k} onClick={() => setKind(kind === k ? "" : k)}>
                {KIND_LABEL[k]} {n.e ? <span className="chip err">{n.e}</span> : null}{n.w ? <span className="chip">{n.w}</span> : null}
              </button>
            ))}
            {!kinds.length && result.points.length > 0 && <span className="chip info">No issues in {plural(result.points.length, "point")}</span>}
          </div>
        </div>
        {general.length > 0 && (
          <div className="issues plb-general">
            {general.map((i, k) => <div key={k} className={`lvl-${i.level}`}>{i.level === "error" ? "Error" : "Warning"}: {i.msg}</div>)}
          </div>
        )}
        <div className="scroll">
          <table className="grid plb-result">
            <thead>
              <tr>
                <th className="idx">#</th>
                <th>Block</th>
                {cols.map((c) => <th key={c.key}>{c.label}</th>)}
                <th title="Last register used (multi-register types)">End</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(page * PAGE, page * PAGE + PAGE).map(({ p, i }) => {
                const iss = p.issues.map((k) => result.issues[k]);
                const bad = (f: string) => iss.filter((x) => x.field === f);
                const lvl = iss.some((x) => x.level === "error") ? "err" : iss.length ? "warn" : "";
                return (
                  <tr key={i} className={[lvl && `r-${lvl}`, p.reserved && "reserved"].filter(Boolean).join(" ") || undefined}>
                    <td className="idx">{i + 1}</td>
                    <td className="ts" title={`Input row ${p.src}`}>{names.get(p.placement)} #{p.inst}</td>
                    {cols.map((c) => {
                      const x = bad(c.key);
                      return <td key={c.key} className={x.length ? (x.some((y) => y.level === "error") ? "cellerr" : "cellwarn") : undefined} title={x.map((y) => y.msg).join("\n") || undefined}>{p.v[c.key]}</td>;
                    })}
                    <td className="mono">{p.addr != null && p.size > 1 ? p.addr + p.size - 1 : ""}</td>
                    <td className="iss">{iss.map((x) => x.msg).join(" · ")}</td>
                  </tr>
                );
              })}
              {!list.length && <tr><td colSpan={cols.length + 4} className="muted">{result.points.length ? "No rows match." : "No points yet: add inputs, tables and placements."}</td></tr>}
            </tbody>
          </table>
          {list.length > PAGE && <Pager page={page} pages={Math.ceil(list.length / PAGE)} setPage={setPage} />}
        </div>
      </section>
    </main>
  );
}
