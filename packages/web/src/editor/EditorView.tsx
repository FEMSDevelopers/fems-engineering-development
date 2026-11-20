import {
  bumpMajor, bumpMinor, colOrder, dataRows, fmtBool, fmtNull, latest, listOrder, moveColumn, parseDelimited, renderRow, renderTable,
  resolveRules, sameVer, stamp, verLabel, width, type BoolFmt, type ConditionState, type ConvertOptions, type Grid, type NullFmt, type Ver,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type Profile, type RuleSet } from "../api";
import { copyText, Gutter, Popover, Seg, useLocal, useUi } from "../ui";
import { CondTable, type RuleKey } from "./CondTable";
import { DataTable } from "./DataTable";
import { JsonRow, JsonTable } from "./JsonPane";
import { LibraryBar } from "./LibraryBar";
import { RuleSetBar } from "./RuleSetBar";
import { DEFAULT_DRAFT, freshState, hashState, toProfileData, V1, type Draft, type Feed, type ProfileData } from "./state";

export type EditorRequest =
  | { kind: "feed"; grid: Grid; feed: Feed; nonce?: number }
  | { kind: "profile"; profileId: string; nonce?: number };

export function EditorView({ active, request, onRequestHandled }: { active: boolean; request: EditorRequest | null; onRequestHandled: () => void }) {
  const ui = useUi();
  const [d, setD] = useLocal<Draft>("fpl.editor.v1", DEFAULT_DRAFT);
  const st = d.st;
  const [selected, setSelected] = useState(0);
  const [selCol, setSelCol] = useState(-1);
  const [scrollKey, setScrollKey] = useState(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [sheets, setSheets] = useState<{ name: string; grid: Grid }[]>([]);
  const [busy, setBusy] = useState(false);
  const splitRef = useRef<HTMLElement>(null);
  const tableScroll = useRef<HTMLDivElement>(null);

  const setSt = useCallback((f: (s: ConditionState) => ConditionState) => setD((x) => ({ ...x, st: f(x.st), sample: false })), [setD]);
  const setOpt = <K extends keyof ConvertOptions>(k: K, v: ConvertOptions[K]) => setD((x) => ({ ...x, st: { ...x.st, opts: { ...x.st.opts, [k]: v } } }));
  const rows = dataRows(st);
  const rules = useMemo(() => resolveRules(st), [st]);
  const hash = useMemo(() => hashState(st), [st]);
  // Example data never counts as unsaved work.
  const dirty = !d.sample && d.lib.savedHash !== hash;
  const tplIdx = Math.min(Math.max(0, selected), Math.max(0, rows.length - 1));

  const refreshProfiles = useCallback(() => api.profiles.list().then(setProfiles).catch(() => {}), []);
  const refreshRuleSets = useCallback(() => api.rulesets.list().then(setRuleSets).catch(() => {}), []);
  useEffect(() => {
    if (!active) return;
    refreshProfiles();
    refreshRuleSets();
  }, [active, refreshProfiles, refreshRuleSets]);

  const curProfile = profiles.find((p) => p.id === d.lib.profileId);
  const versions = curProfile?.versions ?? [];

  // ---------- loading data ----------
  const newGrid = useCallback(
    (grid: Grid, feed: Feed | null = null) => {
      setD((x) => ({
        ...x,
        st: { ...freshState(grid, x.st.opts), opts: { ...x.st.opts, hdr: feed ? true : x.st.opts.hdr } },
        sample: false,
        feed,
        lib: { profileId: null, loaded: null, pending: V1, savedHash: null },
      }));
      setSelected(0);
      setSelCol(-1);
    },
    [setD],
  );

  const confirmDiscard = useCallback(async (what: string) => !dirty || (await ui.confirm(`You have unsaved changes. ${what} and discard them?`, "Discard and continue")), [dirty, ui]);

  const loadVersion = useCallback(
    async (profileId: string, v: Ver, skipConfirm = false) => {
      if (!skipConfirm && !(await confirmDiscard("Load the saved version"))) return;
      try {
        const [ver, prof] = await Promise.all([api.profiles.getVersion(profileId, v.major, v.minor), api.profiles.get(profileId)]);
        const data = ver.data as ProfileData;
        const next: ConditionState = { grid: data.grid, cond: data.cond ?? [], nameRule: data.nameRule, order: data.order ?? [], opts: { ...DEFAULT_DRAFT.st.opts, ...data.opts } };
        setD((x) => ({
          ...x,
          st: next,
          sample: false,
          feed: prof.sourceId ? { sourceId: prof.sourceId, sourceName: prof.sourceName ?? "", cols: prof.sourceCols ?? data.grid[0] ?? [] } : null,
          lib: { profileId, loaded: { major: ver.major, minor: ver.minor }, pending: { major: ver.major, minor: ver.minor }, savedHash: hashState(next) },
        }));
        setSelected(0);
        setSelCol(-1);
        ui.toast(`Loaded v${verLabel(ver)}`);
      } catch (e) {
        ui.toast(`Couldn’t load that version: ${errMsg(e)}`);
      }
    },
    [confirmDiscard, setD, ui],
  );

  const openProfile = useCallback(
    async (id: string) => {
      if (!(await confirmDiscard("Open the other table"))) return;
      try {
        const p = await api.profiles.get(id);
        const v = latest(p.versions);
        if (v) await loadVersion(id, v, true);
        else setD((x) => ({ ...x, lib: { profileId: id, loaded: null, pending: V1, savedHash: null } }));
        refreshProfiles();
      } catch (e) {
        ui.toast(`Couldn’t open that table: ${errMsg(e)}`);
      }
    },
    [confirmDiscard, loadVersion, refreshProfiles, setD, ui],
  );

  // Requests from the Sources module.
  useEffect(() => {
    if (!request || !active) return;
    (async () => {
      if (request.kind === "feed") {
        if (await confirmDiscard("Open the selected source columns")) {
          newGrid(request.grid, request.feed);
          ui.toast(`Opened ${request.feed.cols.length} columns from ${request.feed.sourceName}`);
        }
      } else await openProfile(request.profileId);
      onRequestHandled();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce, active]);

  // Paste from Excel anywhere in the editor.
  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as Element | null;
      if (t instanceof Element && t.matches("input, textarea, select")) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text?.trim()) return;
      e.preventDefault();
      const g = parseDelimited(text);
      setSheets([]);
      newGrid(g);
      ui.toast(`Pasted ${Math.max(0, g.length - (st.opts.hdr ? 1 : 0))} rows · next save starts a new table at v1.001`);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [active, newGrid, st.opts.hdr, ui]);

  // Keyboard: ↑/↓ moves the row (or column in Column conditions); Alt+↑/↓ moves the column in the key order.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as Element | null;
      if (t instanceof Element && t.matches("input, textarea, select")) return;
      if (document.querySelector(".modal-bg")) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (d.mode === "json") {
        setSelected((s) => Math.max(0, Math.min(rows.length - 1, s + dir)));
        setScrollKey((k) => k + 1);
        return;
      }
      const lo = listOrder(st);
      if (selCol < 0) return setSelCol(lo[0] ?? -1);
      const pos = lo.indexOf(selCol);
      if (e.altKey && st.opts.listOrder !== "table") setSt((s) => ({ ...s, order: moveColumn(s, selCol, pos + dir) }));
      else setSelCol(lo[Math.max(0, Math.min(lo.length - 1, pos + dir))]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, d.mode, rows.length, selCol, setSt, st]);

  const openFile = async (f: File) => {
    try {
      const s = await api.parseFile(f);
      if (!(await confirmDiscard("Open the file"))) return;
      setSheets(s.length > 1 ? s : []);
      newGrid(s[0]?.grid ?? [[""]]);
      ui.toast(`Loaded ${f.name}`);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };

  // ---------- saving ----------
  const save = async () => {
    setBusy(true);
    try {
      const p = d.lib.pending;
      let id = d.lib.profileId && curProfile ? d.lib.profileId : null;
      if (!id) {
        const created = await api.profiles.create({
          name: stamp(),
          ...(d.feed ? { sourceId: d.feed.sourceId, sourceName: d.feed.sourceName, sourceCols: d.feed.cols } : {}),
        });
        id = created.id;
      }
      const res = await api.profiles.saveVersion(id, p.major, p.minor, {
        stamp: stamp(),
        data: toProfileData(st),
        meta: { rows: rows.length, cols: width(st.grid) },
      });
      setD((x) => ({ ...x, lib: { profileId: id, loaded: p, pending: p, savedHash: hashState(x.st) } }));
      await refreshProfiles();
      ui.toast(`${res.created ? "Saved" : "Saved over"} v${verLabel(p)}`);
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const pendExists = !!curProfile && versions.some((v) => sameVer(v, d.lib.pending));
  const saveLabel = (pendExists ? "Save v" : curProfile ? "Save as v" : "Save new v") + verLabel(d.lib.pending);
  const setPending = (pending: Ver) => setD((x) => ({ ...x, lib: { ...x.lib, pending } }));

  // ---------- rule toggles ----------
  const toggle = (target: number | "all", f: RuleKey) =>
    setSt((s) => {
      const cond = resolveRules(s);
      if (target === "all") {
        const v = !cond.every((c) => c[f]);
        cond.forEach((c) => (c[f] = v));
      } else cond[target] = { ...cond[target], [f]: !cond[target][f] };
      return { ...s, cond };
    });
  const editCell = (r: number, c: number, v: string) => setSt((s) => ({ ...s, grid: s.grid.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) }));

  // ---------- render ----------
  const isCond = d.mode === "cond";
  const rendered = useMemo(() => (isCond ? null : renderTable(st)), [isCond, st]);
  const rowOut = useMemo(() => (isCond ? renderRow(st, tplIdx) : null), [isCond, st, tplIdx]);
  const o = st.opts;
  const nNA = rules.filter((r) => r.na).length;

  const saveGroup = (
    <div className="savegrp">
      <button type="button" className="save btn-primary" disabled={busy} onClick={save}
        title={(dirty ? "Unsaved changes. " : "") + (pendExists ? `Overwrites v${verLabel(d.lib.pending)}` : `Creates v${verLabel(d.lib.pending)}`) + (curProfile ? "" : " in a new saved table")}>
        {dirty && <span className="dot" />}
        {saveLabel}
      </button>
      <div className="bump">
        <button type="button" title="Next sub-version (1.001 → 1.002)" onClick={() => setPending(bumpMinor(d.lib.pending, versions))}>+.001</button>
        <button type="button" title="Next version (1.xxx → 2.001)" onClick={() => setPending(bumpMajor(d.lib.pending, versions))}>+1.</button>
      </div>
      <button type="button" className="btn-ghost cancelch" disabled={!dirty || !d.lib.profileId || !d.lib.loaded} title={d.lib.loaded ? `Discard the changes and go back to v${verLabel(d.lib.loaded)}` : "Nothing saved yet to go back to"}
        onClick={() => d.lib.profileId && d.lib.loaded && loadVersion(d.lib.profileId, d.lib.loaded)}>Cancel changes</button>
    </div>
  );

  return (
    <section className="view" aria-label="Excel to JSON editor">
      <header className="toolbar">
        <h1>Excel <span>→</span> JSON</h1>
        <label className="btn btn-primary">
          Open file…
          <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" onChange={(e) => (e.target.files?.[0] && openFile(e.target.files[0]), (e.target.value = ""))} />
        </label>
        {sheets.length > 1 && (
          <div className="ctl">
            <label htmlFor="sheet">Sheet</label>
            <select id="sheet" onChange={(e) => newGrid(sheets[+e.target.value].grid)}>
              {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
            </select>
          </div>
        )}
        <span className="sep" />
        <label className="ctl"><input type="checkbox" checked={o.hdr} onChange={(e) => (setOpt("hdr", e.target.checked), setSelected(0))} /> First row is header</label>
        {!isCond && (
          <label className="ctl">Output
            <select value={o.shape} onChange={(e) => setOpt("shape", e.target.value as ConvertOptions["shape"])}>
              <option value="objects">Array of objects</option>
              <option value="keyed">Object keyed by 1st column</option>
              <option value="arrays">Array of arrays</option>
            </select>
          </label>
        )}
        <label className="ctl">Empty cells
          <select value={o.empty} onChange={(e) => setOpt("empty", e.target.value as ConvertOptions["empty"])}>
            <option value="null">null</option><option value="str">""</option><option value="omit">omit key</option>
          </select>
        </label>
        <label className="ctl">Keys
          <select value={o.keys} onChange={(e) => setOpt("keys", e.target.value as ConvertOptions["keys"])}>
            <option value="asis">As written</option><option value="camel">camelCase</option><option value="snake">snake_case</option>
          </select>
        </label>
        {(isCond || o.applyCond) && (
          <div className="ctl">Literals
            <Popover label="True/false and null formatting" button={`${fmtBool(o, true)} · ${fmtNull(o)}`}>
              {() => (
                <div className="litmenu" role="menu">
                  <div className="col">
                    <h4>true / false</h4>
                    {([["lower", "true / false"], ["title", "True / False"], ["upper", "TRUE / FALSE"], ["short", "t / f"]] as [BoolFmt, string][]).map(([v, l]) => (
                      <button key={v} type="button" role="menuitemradio" aria-checked={o.boolFmt === v} onClick={() => setOpt("boolFmt", v)}>{l}</button>
                    ))}
                  </div>
                  <div className="col">
                    <h4>null</h4>
                    {(["null", "Null", "NULL", "None"] as NullFmt[]).map((v) => (
                      <button key={v} type="button" role="menuitemradio" aria-checked={o.nullFmt === v} onClick={() => setOpt("nullFmt", v)}>{v}</button>
                    ))}
                  </div>
                </div>
              )}
            </Popover>
          </div>
        )}
        {!isCond && <label className="ctl"><input type="checkbox" checked={o.applyCond} onChange={(e) => setOpt("applyCond", e.target.checked)} /> Apply column conditions</label>}
        {(isCond || o.applyCond) && (
          <div className="ctl">Key order <Seg label="Key order in JSON" value={o.renderOrder} options={[["custom", "Rearranged"], ["table", "Table order"]]} onChange={(v) => setOpt("renderOrder", v)} /></div>
        )}
        {!isCond && !o.applyCond && (
          <>
            <label className="ctl"><input type="checkbox" checked={o.infer} onChange={(e) => setOpt("infer", e.target.checked)} /> Infer numbers &amp; booleans</label>
            <label className="ctl"><input type="checkbox" checked={o.nest} onChange={(e) => setOpt("nest", e.target.checked)} /> Dotted keys → nested</label>
          </>
        )}
        <label className="ctl">Indent
          <select value={o.indent} onChange={(e) => setOpt("indent", e.target.value as ConvertOptions["indent"])}>
            <option value="2">2</option><option value="4">4</option><option value="tab">Tab</option>
          </select>
        </label>
        <LibraryBar
          store={api.profiles}
          profiles={profiles}
          profileId={d.lib.profileId}
          loaded={d.lib.loaded}
          onPickProfile={(id) => {
            if (id) openProfile(id);
            else {
              setD((x) => ({ ...x, lib: { profileId: null, loaded: null, pending: V1, savedHash: null } }));
              ui.toast("Next save creates a new saved table");
            }
          }}
          onLoad={(id, v) => loadVersion(id, v)}
          onChanged={refreshProfiles}
          onDetach={() => setD((x) => ({ ...x, lib: { profileId: null, loaded: null, pending: V1, savedHash: null } }))}
        />
      </header>

      <nav className="tabs" role="tablist" aria-label="Mode">
        <button className="tab" role="tab" type="button" aria-selected={!isCond} onClick={() => setD((x) => ({ ...x, mode: "json" }))}>Table → JSON</button>
        <button className="tab" role="tab" type="button" aria-selected={isCond} onClick={() => setD((x) => ({ ...x, mode: "cond" }))}>Column conditions</button>
      </nav>

      <main className="split" ref={splitRef}>
        <section className="pane" aria-label="Table">
          <div className="pane-head">
            <h2>Table</h2>
            {d.sample && <span className="chip">Example data</span>}
            {d.feed && <span className="chip info" title={d.feed.cols.join(", ")}>From source: {d.feed.sourceName}</span>}
            {isCond ? (
              <>
                <div className="rowpick">
                  <label htmlFor="tplRow">Template row</label>
                  <button type="button" aria-label="Previous row" onClick={() => setSelected(Math.max(0, tplIdx - 1))}>‹</button>
                  <select id="tplRow" value={tplIdx} onChange={(e) => setSelected(+e.target.value)}>
                    {rows.map((r, i) => <option key={i} value={i}>[{i}] {(r[0] ?? "").slice(0, 40)}</option>)}
                  </select>
                  <button type="button" aria-label="Next row" onClick={() => setSelected(Math.min(rows.length - 1, tplIdx + 1))}>›</button>
                </div>
                <div className="ctl">List
                  <Seg label="List order" value={o.listOrder} options={[["custom", "Rearranged"], ["table", "Table order"]]} onChange={(v) => setOpt("listOrder", v)} />
                  <button type="button" onClick={() => (setSt((s) => ({ ...s, order: [] })), ui.toast("Order reset to table order"))}>Reset order</button>
                </div>
                <div className="rightgrp">
                  {saveGroup}
                  <RuleSetBar
                    st={st}
                    ruleSets={ruleSets}
                    tpl={d.tpl}
                    defaultName={curProfile ? `${curProfile.name} rules` : d.feed ? `${d.feed.sourceName} rules` : ""}
                    onTpl={(tpl) => setD((x) => ({ ...x, tpl }))}
                    onApply={(next, tpl, n, label) => {
                      setD((x) => ({ ...x, st: next, tpl, sample: false }));
                      ui.toast(`Applied rule set v${label} to ${n} columns`);
                    }}
                    onChanged={refreshRuleSets}
                  />
                </div>
              </>
            ) : (
              <>
                <span className="hint">Paste from Excel anywhere (<kbd>Ctrl</kbd>+<kbd>V</kbd>), open a file, double-click a cell to edit, <kbd>↑</kbd><kbd>↓</kbd> to move.</span>
                <div className="rightgrp">{saveGroup}</div>
              </>
            )}
          </div>
          {isCond && (
            <div className="legend">
              <span><b>NA</b> leave column out</span><span><b>#</b> strip quotes</span><span><b>"#"</b> add quotes</span>
              <span><b>b_tf</b> 1 → true, 0 → false</span><span><b>b_10</b> true → 1, false → 0</span><span><b>b_r</b> invert b_tf / b_10</span>
              <span>The "Column names" row applies # / "#" to every key; the rows below apply to each column's value. Strip runs before add; b_tf / b_10 results are written as bare literals.</span>
            </div>
          )}
          <div className="scroll" ref={tableScroll} tabIndex={0}>
            {isCond ? (
              <CondTable
                st={st}
                rules={rules}
                tplIdx={tplIdx}
                selCol={selCol}
                onSelectCol={setSelCol}
                onToggle={toggle}
                onToggleName={(f) => setSt((s) => ({ ...s, nameRule: { ...s.nameRule, [f]: !s.nameRule[f] } }))}
                onDef={(j, v) => setSt((s) => {
                  const cond = resolveRules(s);
                  cond[j] = { ...cond[j], def: v };
                  return { ...s, cond };
                })}
                onDrop={(j, beforeCol, after) => setSt((s) => {
                  const o2 = colOrder(s).filter((x) => x !== j);
                  return { ...s, order: moveColumn(s, j, o2.indexOf(beforeCol) + (after ? 1 : 0)) };
                })}
                onEdit={editCell}
              />
            ) : (
              <DataTable st={st} selected={selected} onSelect={setSelected} onEdit={editCell} scrollRef={tableScroll} />
            )}
          </div>
        </section>
        <Gutter target={splitRef} />
        <section className="pane" aria-label="JSON">
          <div className="pane-head">
            <h2>JSON</h2>
            <span className="hint">
              {isCond ? `Template: row [${tplIdx}]. Switch to Table → JSON to check the other rows.` : rendered?.items[selected] ? `Selected element [${selected}]` : "Click a row to focus its element."}
            </span>
            <div className="tools">
              {!isCond && (
                <button type="button" disabled={!rendered?.items[selected]} onClick={async () => ui.toast((await copyText(rendered!.items[selected].text)) ? `Element [${selected}] copied` : "Copy blocked")}>
                  Copy selected
                </button>
              )}
              <button type="button" className="btn-primary" onClick={async () => ui.toast((await copyText(isCond ? rowOut!.text : rendered!.text)) ? (isCond ? "Row copied" : "JSON copied") : "Copy blocked")}>
                {isCond ? "Copy row" : "Copy JSON"}
              </button>
            </div>
          </div>
          {isCond ? (
            <JsonRow lines={rowOut!.lines} selCol={selCol} onSelectCol={setSelCol} />
          ) : (
            <JsonTable r={rendered!} selected={selected} onSelect={(i) => setSelected(i)} scrollKey={scrollKey} />
          )}
        </section>
      </main>

      <footer className="status">
        {isCond ? (
          <>
            <span>Template row [{tplIdx}] of {rows.length} · {width(st.grid)} columns</span>
            <span>Names {st.nameRule.q ? "quoted" : "unquoted"}{st.nameRule.n ? ", quotes stripped" : ""} · quoted values {rules.filter((r) => r.q).length}/{rules.length} · boolean rules {rules.filter((r) => r.tf || r.t10).length}/{rules.length}</span>
            <span>{nNA} column{nNA === 1 ? "" : "s"} left out (NA) · key order: {o.renderOrder === "table" ? "table" : "rearranged"}</span>
          </>
        ) : (
          <>
            <span>{rows.length} row{rows.length === 1 ? "" : "s"} × {width(st.grid)} column{width(st.grid) === 1 ? "" : "s"}</span>
            <span>{rendered!.text.split("\n").length} lines · {(new Blob([rendered!.text]).size / 1024).toFixed(1)} KB</span>
            {o.applyCond && <span>Column conditions applied</span>}
            {rendered!.duplicateKeys.length > 0 && <span className="warn">Duplicate keys in column 1: {rendered!.duplicateKeys.slice(0, 5).join(", ")}. Later rows overwrite earlier ones when parsed.</span>}
          </>
        )}
        {curProfile && <span>Saved table: {curProfile.name}{d.lib.loaded ? ` · v${verLabel(d.lib.loaded)}` : ""}{dirty ? " · unsaved changes" : ""}</span>}
      </footer>
    </section>
  );
}
