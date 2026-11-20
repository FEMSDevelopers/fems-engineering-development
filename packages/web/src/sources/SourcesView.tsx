import {
  fieldsFor, fmtDateTime, isPointList, latest, parseDelimited, selectColumns, SOURCE_KINDS, validateSource, verLabel,
  type Grid, type PointField, type ProtocolMap,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errMsg, type Profile, type SourceFull, type SourceMeta } from "../api";
import type { EditorRequest } from "../editor/EditorView";
import { Modal, useLocal, useUi } from "../ui";
import { PointListBuilder } from "./PointListBuilder";

const PREVIEW_ROWS = 100;

export function SourcesView({ active, openInEditor }: { active: boolean; openInEditor: (r: EditorRequest) => void }) {
  const ui = useUi();
  const [list, setList] = useState<SourceMeta[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [src, setSrc] = useState<SourceFull | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importer, setImporter] = useState<{ replace?: SourceMeta } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [builder, setBuilder] = useLocal<boolean>("fpl.src.builder", false);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.sources.list(), api.profiles.list()]);
      setList(s);
      setProfiles(p);
      setLoadErr(null);
      setSelId((cur) => (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null));
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  useEffect(() => {
    if (!selId) return setSrc(null);
    let live = true;
    api.sources.get(selId).then((s) => {
      if (!live) return;
      setSrc(s);
      setPicked(new Set(s.headers));
    }).catch((e) => ui.toast(errMsg(e)));
    return () => {
      live = false;
    };
  }, [selId, reload, ui]);

  const update = async (body: Parameters<typeof api.sources.update>[1]) => {
    if (!src) return;
    try {
      const m = await api.sources.update(src.id, body);
      setSrc({ ...src, ...m, rows: body.grid ? body.grid.slice(1) : src.rows });
      setList((l) => l.map((x) => (x.id === m.id ? m : x)));
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    }
  };

  const grid: Grid = useMemo(() => (src ? [src.headers, ...src.rows] : []), [src]);
  const issues = useMemo(() => (src && isPointList(src.kind) ? validateSource(src.kind, grid, src.protocolMap) : []), [src, grid]);
  const srcProfiles = profiles.filter((p) => p.sourceId === src?.id);

  const feed = () => {
    if (!src) return;
    const cols = src.headers.filter((h) => picked.has(h));
    if (!cols.length) return ui.toast("Pick at least one column");
    openInEditor({ kind: "feed", grid: selectColumns(grid, cols).grid, feed: { sourceId: src.id, sourceName: src.name, cols } });
  };

  if (builder)
    return (
      <PointListBuilder
        onClose={() => (setBuilder(false), refresh())}
        onPublished={async (id) => {
          await refresh();
          setSelId(id);
          setReload((n) => n + 1);
        }}
      />
    );

  return (
    <section className="view simple" aria-label="Sources">
      <header className="toolbar">
        <h1>Sources</h1>
        <span className="muted">Project tables: point lists and other data that feed the editor and outputs.</span>
        <span className="grow" />
        <button type="button" onClick={() => setBuilder(true)} title="Build a point list from raw tables with reusable rules, arrays and checks">Point list builder…</button>
        <button type="button" className="btn-primary" onClick={() => setImporter({})}>New source…</button>
      </header>
      <main className="split list">
        <section className="pane" aria-label="Source list">
          <div className="pane-head"><h2>Project tables</h2><span className="hint">{list.length} source{list.length === 1 ? "" : "s"}</span></div>
          <div className="scroll">
            {loadErr ? (
              <div className="empty-state"><h3>Can’t reach the server</h3><p>{loadErr}</p><button type="button" onClick={refresh}>Retry</button></div>
            ) : !list.length ? (
              <div className="empty-state">
                <h3>No sources yet</h3>
                <p>Add a Modbus TCP, DNP3 or IEC 104 point list (or any table) by pasting from Excel or opening a file.</p>
                <div className="toolbar"><button type="button" className="btn-primary" onClick={() => setImporter({})}>New source…</button><button type="button" onClick={() => setBuilder(true)}>Point list builder…</button></div>
              </div>
            ) : (
              <ul className="srclist">
                {list.map((s) => (
                  <li key={s.id}>
                    <button type="button" aria-current={s.id === selId} onClick={() => setSelId(s.id)}>
                      <span className="nm">{s.name}</span>
                      <span className="meta">
                        <span>{SOURCE_KINDS[s.kind as keyof typeof SOURCE_KINDS] ?? s.kind}</span>
                        <span>{s.rowCount} rows × {s.headers.length} cols</span>
                        <span>{fmtDateTime(s.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <div />
        <section className="pane" aria-label="Source detail">
          <div className="scroll">
            {!src ? (
              <div className="empty-state"><p>Select a source on the left.</p></div>
            ) : (
              <>
                <div className="card">
                  <div className="head">
                    <input type="text" aria-label="Source name" defaultValue={src.name} key={src.id + src.name} style={{ fontWeight: 600, fontSize: 15, minWidth: 260 }}
                      onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== src.name && update({ name: e.target.value.trim() })} />
                    <select aria-label="Kind" value={src.kind} onChange={(e) => update({ kind: e.target.value })}>
                      {Object.entries(SOURCE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <span className="muted">{src.rowCount} rows × {src.headers.length} columns · updated {fmtDateTime(src.updatedAt)}</span>
                    <span className="grow" style={{ flex: 1 }} />
                    <button type="button" onClick={() => setImporter({ replace: src })}>Replace data…</button>
                    <button type="button" className="btn-danger" onClick={async () => {
                      if (!(await ui.confirm(`Delete source "${src.name}"? Devices linked to it lose their point list. Saved editor profiles are kept.`, "Delete source"))) return;
                      await api.sources.remove(src.id);
                      ui.toast("Source deleted");
                      setSelId(null);
                      refresh();
                    }}>Delete</button>
                  </div>
                </div>

                {isPointList(src.kind) && (
                  <div className="card">
                    <div className="head">
                      <h3>Protocol declaration</h3>
                      <span className="muted">Map this table's columns to {SOURCE_KINDS[src.kind]} fields. <b style={{ color: "var(--err)" }}>*</b> required.</span>
                    </div>
                    <div className="pmap">
                      {fieldsFor(src.kind).map((f) => (
                        <label key={f.key}>
                          <span>{f.label}{f.required && <b> *</b>}</span>
                          <select value={src.protocolMap[f.key] ?? ""} onChange={(e) => {
                            const m: ProtocolMap = { ...src.protocolMap };
                            if (e.target.value) m[f.key as PointField] = e.target.value;
                            else delete m[f.key as PointField];
                            update({ protocolMap: m as Record<string, string> });
                          }}>
                            <option value="">— not mapped —</option>
                            {src.headers.map((h, i) => <option key={i} value={h}>{h}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                    <div className="head">
                      {issues.length === 0 ? (
                        <span className="chip info">No problems found in {src.rowCount} rows</span>
                      ) : (
                        <>
                          <span className="chip err">{issues.filter((i) => i.level === "error").length} errors</span>
                          <span className="chip">{issues.filter((i) => i.level === "warn").length} warnings</span>
                        </>
                      )}
                    </div>
                    {issues.length > 0 && (
                      <div className="issues">
                        <table>
                          <tbody>
                            {issues.slice(0, 200).map((i, k) => (
                              <tr key={k}>
                                <td className={`lvl-${i.level}`}>{i.level === "error" ? "Error" : "Warning"}</td>
                                <td className="mono">{i.row == null ? "Table" : `Row ${i.row}`}</td>
                                <td className="mono">{i.field}</td>
                                <td>{i.msg}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                <div className="card">
                  <div className="head"><h3>Conditioning profiles</h3><span className="muted">Editor tables saved from this source. Outputs use the most recently saved one.</span></div>
                  {srcProfiles.length ? (
                    <table className="vt">
                      <thead><tr><th>Profile</th><th>Latest</th><th>Saved</th><th>Columns</th><th /></tr></thead>
                      <tbody>
                        {srcProfiles.map((p, i) => {
                          const v = latest(p.versions);
                          return (
                            <tr key={p.id}>
                              <td>{p.name}{i === 0 && <> <span className="chip info">used by outputs</span></>}</td>
                              <td className="v">{v ? `v${verLabel(v)}` : "—"}</td>
                              <td className="ts">{fmtDateTime(v?.savedAt)}</td>
                              <td className="ts" title={(p.sourceCols ?? []).join(", ")}>{p.sourceCols?.length ?? 0}</td>
                              <td><button type="button" onClick={() => openInEditor({ kind: "profile", profileId: p.id })}>Open in editor</button></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>None yet. Pick columns below and open them in the editor; saving there creates a profile for this source.</p>
                  )}
                </div>

                <div className="card">
                  <div className="head">
                    <h3>Data</h3>
                    <span className="muted">{picked.size} of {src.headers.length} columns selected</span>
                    <button type="button" onClick={() => setPicked(new Set(src.headers))}>All</button>
                    <button type="button" onClick={() => setPicked(new Set())}>None</button>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="btn-primary" disabled={!picked.size} onClick={feed}>Open {picked.size} column{picked.size === 1 ? "" : "s"} in editor</button>
                  </div>
                  <div className="preview">
                    <table className="grid">
                      <thead>
                        <tr>
                          <th className="idx">#</th>
                          {src.headers.map((h, i) => (
                            <th key={i}>
                              <label>
                                <input type="checkbox" checked={picked.has(h)} onChange={(e) => {
                                  const s = new Set(picked);
                                  if (e.target.checked) s.add(h);
                                  else s.delete(h);
                                  setPicked(s);
                                }} />
                                {h}
                              </label>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {src.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                          <tr key={i}>
                            <td className="idx">{i + 1}</td>
                            {src.headers.map((_, j) => <td key={j} className={(r[j] ?? "") === "" ? "empty" : undefined}>{r[j]}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {src.rowCount > PREVIEW_ROWS && <span className="muted">Showing {PREVIEW_ROWS} of {src.rowCount} rows. All rows go to the editor.</span>}
                </div>
              </>
            )}
          </div>
        </section>
      </main>
      {importer && (
        <ImportSourceModal
          replace={importer.replace}
          onClose={() => setImporter(null)}
          onDone={async (id) => {
            setImporter(null);
            await refresh();
            setSelId(id);
            setReload((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

function ImportSourceModal({ replace, onClose, onDone }: { replace?: SourceMeta; onClose: () => void; onDone: (id: string) => void }) {
  const ui = useUi();
  const [name, setName] = useState(replace?.name ?? "");
  const [kind, setKind] = useState(replace?.kind ?? "modbus");
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<{ name: string; grid: Grid }[]>([]);
  const [sheet, setSheet] = useState(0);
  const [busy, setBusy] = useState(false);
  const grid: Grid = text.trim() ? parseDelimited(text) : sheets[sheet]?.grid ?? [];
  const save = async () => {
    if (!grid.length) return ui.toast("Paste cells or open a file first");
    setBusy(true);
    try {
      if (replace) {
        await api.sources.update(replace.id, { grid, name: name.trim() || replace.name });
        ui.toast("Source data replaced");
        onDone(replace.id);
      } else {
        const s = await api.sources.create({ name: name.trim() || sheets[sheet]?.name || "Untitled source", kind, grid });
        ui.toast(`Source saved · ${grid.length - 1} rows`);
        onDone(s.id);
      }
    } catch (e) {
      ui.toast(`Couldn’t save the source: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={replace ? "Replace source data" : "New source"}>
      <div className="mh"><h3>{replace ? `Replace data in ${replace.name}` : "New source"}</h3></div>
      <div className="mb">
        <div className="frow">
          <label className="f">Name<input type="text" value={name} placeholder="e.g. PCS Modbus map rev C" onChange={(e) => setName(e.target.value)} /></label>
          {!replace && (
            <label className="f">Kind
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(SOURCE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          )}
        </div>
        <label className="f">Paste cells from Excel (first row = column headers)
          <textarea rows={9} value={text} placeholder="Click here and press Ctrl+V" onChange={(e) => setText(e.target.value)} style={{ fontFamily: "var(--f-mono)", fontSize: 12 }} />
        </label>
        <div className="toolbar">
          <label className="btn">
            Or open a file…
            <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                const s = await api.parseFile(f);
                setSheets(s);
                setSheet(0);
                setText("");
                if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
              } catch (err) {
                ui.toast(errMsg(err));
              }
            }} />
          </label>
          {sheets.length > 1 && !text.trim() && (
            <label className="ctl">Sheet
              <select value={sheet} onChange={(e) => setSheet(+e.target.value)}>{sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select>
            </label>
          )}
          <span className="muted">{grid.length ? `${Math.max(0, grid.length - 1)} rows × ${grid[0]?.length ?? 0} columns ready` : "Nothing loaded yet"}</span>
        </div>
        {replace && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The protocol declaration is kept; columns are matched by header name, so keep header names the same.</p>}
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !grid.length} onClick={save}>{replace ? "Replace data" : "Save source"}</button>
      </div>
    </Modal>
  );
}
