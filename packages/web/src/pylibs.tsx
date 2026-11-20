import { bumpMinor, evalExpr, exportFileName, latest, loadLibrary, makeLibFile, parseLibFile, stamp, verLabel, type PyLibFileEntry, type PyLibrary, type PyValue, type Ver } from "@fpl/core";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { api, type Versioned } from "./api";
import { HoldButton, Modal, useUi } from "./ui";

/** The function library being edited (Functions tab). */
export interface PyLibDraft {
  name: string;
  code: string;
  /** "Try it" expressions (saved with each version). */
  tries?: string[];
}
const DEFAULT_TRIES = ['first_number("PCS_12_A", "_")', 'first_number("rack 3.5 x")'];
/** A blank library for "New". */
export const BLANK_LIB: PyLibDraft = {
  name: "",
  code: `def new_function(value):
    """Describe what it returns (the first line is shown as help)."""
    return value
`,
  tries: ['new_function("abc")'],
};
export const EMPTY_LIB: PyLibDraft = {
  name: "",
  code: `def first_number(value, sep=None):
    """Split \`value\` and return the first fragment that parses as a number
    (left to right). Returns None if no fragment is numeric."""
    for fragment in str(value).split(sep):
        fragment = fragment.strip()
        try:
            num = float(fragment)
        except ValueError:
            continue
        return int(num) if num.is_integer() else num
    return None
`,
  tries: DEFAULT_TRIES,
};
export interface LibRef {
  /** Saved library id, or "draft" = the library open in the Functions tab. */
  id: string;
  ver: Ver | null;
}

/** Saved function libraries (list, refreshed on demand). */
export function useLibItems(active = true, key?: unknown) {
  const [items, setItems] = useState<Versioned[]>([]);
  const refresh = () => api.pyLibs.list().then(setItems).catch(() => {});
  useEffect(() => {
    if (active) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return { items, refresh };
}

/** Code of each referenced library (in order); "draft" resolves to draftCode. */
export function useLibCodes(refs: LibRef[], items: Versioned[], draftCode?: string): { codes: string[]; names: string[] } {
  const cache = useRef(new Map<string, string>());
  const [, bump] = useState(0);
  const res = refs.map((r) => {
    if (r.id === "draft") return { key: "", code: draftCode ?? "", name: "Draft (Functions tab)" };
    const it = items.find((x) => x.id === r.id);
    const v = r.ver ?? (it ? latest(it.versions) ?? null : null);
    const key = it && v ? `${r.id}@${v.major}.${v.minor}` : "";
    return { key, code: key ? cache.current.get(key) ?? null : null, name: it ? `${it.name} v${v ? verLabel(v) : "–"}` : "(deleted)", id: r.id, v };
  });
  const want = res.map((r) => r.key).join("|");
  useEffect(() => {
    let live = true;
    for (const r of res) {
      if (!r.key || cache.current.has(r.key) || !("id" in r)) continue;
      api.pyLibs.getVersion(r.id!, r.v!.major, r.v!.minor).then((x) => {
        cache.current.set(r.key, (x.data as PyLibDraft)?.code ?? "");
        if (live) bump((n) => n + 1);
      }).catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);
  return { codes: res.map((r) => r.code ?? ""), names: res.map((r) => r.name) };
}

/** Names defined by several libraries (each sees the ones before it and `base`). */
export function mergeLibs(codes: string[], base: Record<string, PyValue> = {}): { names: Record<string, PyValue>; libs: PyLibrary[] } {
  let names: Record<string, PyValue> = {};
  const libs: PyLibrary[] = [];
  for (const c of codes) {
    const L = loadLibrary(c, { ...base, ...names });
    libs.push(L);
    names = { ...names, ...L.names };
  }
  return { names, libs };
}

/** Pick saved function libraries (with version, or latest). */
export function LibPicker({ refs, onChange, items, allowDraft }: { refs: LibRef[]; onChange: (r: LibRef[]) => void; items: Versioned[]; allowDraft?: boolean }) {
  const free = items.filter((x) => !refs.some((r) => r.id === x.id));
  return (
    <div className="libpick">
      {refs.map((r, i) => {
        const it = items.find((x) => x.id === r.id);
        const versions = (it?.versions ?? []).slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
        return (
          <div className="toolbar sub" key={r.id + i}>
            <span className="chip info">{r.id === "draft" ? "Draft (Functions tab)" : it?.name ?? "(deleted library)"}</span>
            {r.id !== "draft" && (
              <select aria-label="Library version" value={r.ver ? verLabel(r.ver) : ""} onChange={(e) => onChange(refs.map((x, k) => (k === i ? { ...x, ver: e.target.value ? versions.find((v) => verLabel(v) === e.target.value) ?? null : null } : x)))}>
                <option value="">Latest{it && latest(it.versions) ? ` (v${verLabel(latest(it.versions)!)})` : ""}</option>
                {versions.map((v) => <option key={verLabel(v)} value={verLabel(v)}>v{verLabel(v)}{v.notes ? ` — ${v.notes.slice(0, 30)}` : ""}</option>)}
              </select>
            )}
            <HoldButton label={`Remove library ${it?.name ?? "draft"}`} onHold={() => onChange(refs.filter((_, k) => k !== i))}>✕</HoldButton>
          </div>
        );
      })}
      <select aria-label="Add function library" value="" onChange={(e) => e.target.value && onChange([...refs, { id: e.target.value, ver: null }])}>
        <option value="">+ Function library…</option>
        {allowDraft && !refs.some((r) => r.id === "draft") && <option value="draft">Draft (Functions tab)</option>}
        {free.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </div>
  );
}

export type PalChip = (p: { code: string; help: string; onPick?: () => void }) => ReactElement;

/**
 * "Functions" tab of the expression popups: the attached libraries (version, remove) with their
 * functions as chips, and every other saved library with its functions — picking one of those
 * attaches the library (Latest) and inserts the call.
 */
export function FunctionsPalette({ refs, onRefs, items, libs, Chip, draftCode, allowDraft, base, onRefresh, where }: {
  refs: LibRef[]; onRefs: (r: LibRef[]) => void; items: Versioned[]; libs: PyLibrary[]; Chip: PalChip;
  draftCode?: string; allowDraft?: boolean; base?: Record<string, PyValue>; onRefresh?: () => unknown; where: string;
}) {
  useEffect(() => {
    onRefresh?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const avail: LibRef[] = [
    ...(allowDraft && !refs.some((r) => r.id === "draft") && draftCode?.trim() ? [{ id: "draft", ver: null }] : []),
    ...items.filter((x) => !refs.some((r) => r.id === x.id)).map((x) => ({ id: x.id, ver: null })),
  ];
  const { codes: availCodes, names: availNames } = useLibCodes(avail, items, draftCode);
  const attachedNames = refs.map((r) => (r.id === "draft" ? "Draft (Functions tab)" : items.find((x) => x.id === r.id)?.name ?? "(deleted library)"));
  const availLibs = useMemo(() => availCodes.map((c) => loadLibrary(c, base ?? {})), [availCodes.join("\u0000"), base]); // eslint-disable-line react-hooks/exhaustive-deps
  const help = (doc: string) => doc.split("\n")[0] || "Custom function";
  return (
    <>
      <div>
        <h4>Attached to {where}</h4>
        {refs.map((r, i) => {
          const it = items.find((x) => x.id === r.id);
          const versions = (it?.versions ?? []).slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
          const L = libs[i];
          return (
            <div key={r.id + i} className="fnlib">
              <div className="toolbar sub">
                <strong>{attachedNames[i]}</strong>
                {r.id !== "draft" && (
                  <select aria-label={`Version of ${attachedNames[i]}`} value={r.ver ? verLabel(r.ver) : ""} onChange={(e) => onRefs(refs.map((x, k) => (k === i ? { ...x, ver: e.target.value ? versions.find((v) => verLabel(v) === e.target.value) ?? null : null } : x)))}>
                    <option value="">Latest{it && latest(it.versions) ? ` (v${verLabel(latest(it.versions)!)})` : ""}</option>
                    {versions.map((v) => <option key={verLabel(v)} value={verLabel(v)}>v{verLabel(v)}{v.notes ? ` — ${v.notes.slice(0, 30)}` : ""}</option>)}
                  </select>
                )}
                <button type="button" className="btn-ghost" aria-label={`Detach ${attachedNames[i]}`} title="Detach this library" onClick={() => onRefs(refs.filter((_, k) => k !== i))}>✕</button>
              </div>
              {L?.error && <span className="chip err">{L.error}</span>}
              {L?.funcs.map((f) => <Chip key={f.name} code={f.sig} help={help(f.doc)} />)}
              {L && !L.error && !L.funcs.length && <span className="muted">Loading… / no functions</span>}
            </div>
          );
        })}
        {!refs.length && <span className="muted">None yet — pick a function below; its library is attached to {where}.</span>}
      </div>
      <div>
        <h4>Other function libraries</h4>
        {avail.map((r, i) => {
          const L = availLibs[i];
          const attach = () => onRefs([...refs, r]);
          return (
            <div key={r.id} className="fnlib">
              <div className="toolbar sub">
                <strong>{availNames[i]}</strong>
                <button type="button" onClick={attach}>Attach</button>
              </div>
              {L?.error && <span className="chip err">{L.error}</span>}
              {L?.funcs.map((f) => <Chip key={f.name} code={f.sig} help={`${help(f.doc)} · attaches ${availNames[i]}`} onPick={attach} />)}
            </div>
          );
        })}
        {!avail.length && <span className="muted">{items.length || refs.length ? "Every library is attached." : "No saved function libraries yet. Write one in JSON editor → 5 Functions and save it."}</span>}
      </div>
    </>
  );
}

/** Editor for one function library: code, defined functions and a live "try it" console. */
export function FunctionsEditor({ draft, setDraft, base, hint, tools }: { draft: PyLibDraft; setDraft: (d: PyLibDraft) => void; base?: Record<string, PyValue>; hint?: string; tools?: ReactNode }) {
  const lib = useMemo(() => loadLibrary(draft.code, base ?? {}), [draft.code, base]);
  // Saved with the library (old versions without them start with the defaults).
  const tries = draft.tries ?? DEFAULT_TRIES;
  const setTries = (t: string[]) => setDraft({ ...draft, tries: t });
  const ta = useRef<HTMLTextAreaElement>(null);
  const lineOf = /line (\d+)/.exec(lib.error ?? "")?.[1];
  const go = () => {
    if (!lineOf || !ta.current) return;
    const lines = draft.code.split("\n");
    const pos = lines.slice(0, +lineOf - 1).reduce((a, l) => a + l.length + 1, 0);
    ta.current.focus();
    ta.current.setSelectionRange(pos, pos + (lines[+lineOf - 1]?.length ?? 0));
  };
  return (
    <div className="funcs">
      <section className="pane" aria-label="Library code">
        <div className="pane-head">
          <input type="text" aria-label="Library name" placeholder="Library name, e.g. Tag helpers" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ minWidth: 220, fontWeight: 600 }} />
          {lib.error ? <><span className="chip err">{lib.error}</span>{lineOf && <button type="button" onClick={go}>Go to line {lineOf}</button>}</> : <span className="chip info">{lib.funcs.length} function{lib.funcs.length === 1 ? "" : "s"} · OK</span>}
          <span className="hint">{hint}</span>
          {tools && <span className="funcs-tools">{tools}</span>}
        </div>
        <textarea ref={ta} aria-label="Library code" className="funcs-code" spellCheck={false} value={draft.code}
          onKeyDown={(e) => {
            // Tab inserts 4 spaces (Python indentation)
            if (e.key !== "Tab") return;
            e.preventDefault();
            const el = e.currentTarget;
            const a = el.selectionStart;
            const z = el.selectionEnd;
            setDraft({ ...draft, code: draft.code.slice(0, a) + "    " + draft.code.slice(z) });
            requestAnimationFrame(() => (el.selectionStart = el.selectionEnd = a + 4));
          }}
          onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
      </section>
      <section className="pane" aria-label="Functions">
        <div className="pane-head"><h2>Functions</h2><span className="hint">Defined by this library</span></div>
        <div className="scroll">
          <table className="vt funcs-list">
            <tbody>
              {lib.funcs.map((f) => (
                <tr key={f.name}><td><code>{f.sig}</code>{f.doc && <div className="muted doc">{f.doc}</div>}</td></tr>
              ))}
              {!lib.funcs.length && <tr><td className="muted">No def found. Write e.g. <code>def name(value):</code> with an indented body that returns a value.</td></tr>}
            </tbody>
          </table>
          <div className="card">
            <div className="head"><h3>Try it</h3><span className="muted">Expressions evaluated with this library</span></div>
            {tries.map((t, i) => {
              let out = "";
              let err = "";
              try {
                out = t.trim() ? evalExpr(t, { ...(base ?? {}), ...lib.names }) : "";
              } catch (e) {
                err = (e as Error).message;
              }
              return (
                <div key={i} className="trybox">
                  <input type="text" aria-label={`Try expression ${i + 1}`} value={t} onChange={(e) => setTries(tries.map((x, k) => (k === i ? e.target.value : x)))} spellCheck={false} />
                  <span className={err ? "chip err" : "res"}>{err || (out === "" ? "None / empty" : out)}</span>
                  <button type="button" className="btn-ghost" aria-label="Remove" onClick={() => setTries(tries.filter((_, k) => k !== i))}>✕</button>
                </div>
              );
            })}
            <button type="button" onClick={() => setTries([...tries, ""])}>+ Try</button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- export / import

const downloadText = (name: string, text: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
/** Epoch milliseconds with sub-millisecond precision (for the ssss part of the file name). */
const nowPrecise = () => (typeof performance !== "undefined" && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now());
const sigs = (code: string) => loadLibrary(code).funcs.map((f) => f.sig);

/** Export… / Import… buttons for function libraries (file Jsoneditor_export_YYYYDDMM_HHMMSSssss.json). */
export function LibFileTools({ draft, setDraft, items, refresh, base }: {
  draft: PyLibDraft; setDraft: (d: PyLibDraft) => void; items: Versioned[]; refresh: () => unknown; base?: Record<string, PyValue>;
}) {
  const ui = useUi();
  const [exp, setExp] = useState(false);
  const [imp, setImp] = useState<{ file: string; libs: (PyLibFileEntry & { on: boolean; target: string })[]; error?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const read = async (f: File) => {
    const r = parseLibFile(await f.text(), f.name);
    setImp({
      file: f.name, error: r.error,
      libs: r.libraries.map((l) => ({ ...l, on: true, target: items.find((x) => x.name.trim().toLowerCase() === l.name.trim().toLowerCase())?.id ?? "new" })),
    });
  };
  return (
    <>
      <button type="button" onClick={() => (refresh(), setExp(true))} title="Download function libraries as a file">Export…</button>
      <button type="button" onClick={() => fileRef.current?.click()} title="Read function libraries from an export file (.json) or Python source (.py)">Import…</button>
      <input ref={fileRef} type="file" accept=".json,.py,.txt,application/json,text/x-python,text/plain" hidden aria-label="Import function libraries file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void read(f); }} />
      {exp && <ExportModal draft={draft} items={items} onClose={() => setExp(false)} onDone={(n, name) => (ui.toast(`Exported ${n} librar${n === 1 ? "y" : "ies"} to ${name}`), setExp(false))} />}
      {imp && (
        <Modal onClose={() => setImp(null)} label="Import function libraries">
          <div className="mh"><h3>Import function libraries</h3><span className="muted">{imp.file}</span></div>
          <div className="mb">
            {imp.error && <span className="chip err">{imp.error}</span>}
            <table className="vt libfile">
              <thead><tr><th></th><th>Library</th><th>In file</th><th>Functions</th><th>Save as</th><th></th></tr></thead>
              <tbody>
                {imp.libs.map((l, i) => {
                  const L = loadLibrary(l.code, base ?? {});
                  const set = (x: Partial<typeof l>) => setImp({ ...imp, libs: imp.libs.map((y, k) => (k === i ? { ...y, ...x } : y)) });
                  return (
                    <tr key={i}>
                      <td><input type="checkbox" aria-label={`Import ${l.name}`} checked={l.on} onChange={(e) => set({ on: e.target.checked })} /></td>
                      <td><input type="text" aria-label="Library name" value={l.name} onChange={(e) => set({ name: e.target.value })} /></td>
                      <td className="muted">{l.version ? `v${l.version}` : "—"}{l.notes ? ` · ${l.notes.slice(0, 40)}` : ""}</td>
                      <td>{L.error ? <span className="chip err">{L.error}</span> : <code className="sigs">{L.funcs.map((f) => f.sig).join("\n") || "none"}</code>}</td>
                      <td>
                        <select aria-label={`Save ${l.name} as`} value={l.target} onChange={(e) => set({ target: e.target.value })}>
                          <option value="new">New library</option>
                          {items.map((x) => <option key={x.id} value={x.id}>Next sub-version of {x.name}{latest(x.versions) ? ` (v${verLabel(bumpMinor(latest(x.versions)!, x.versions))})` : ""}</option>)}
                        </select>
                      </td>
                      <td><button type="button" onClick={() => (setDraft({ name: l.name, code: l.code, ...(l.tries ? { tries: l.tries } : {}) }), setImp(null), ui.toast(`Opened ${l.name} in the editor (not saved yet)`))}>Open in editor</button></td>
                    </tr>
                  );
                })}
                {!imp.libs.length && <tr><td colSpan={6} className="muted">Nothing to import.</td></tr>}
              </tbody>
            </table>
            <p className="muted" style={{ margin: 0 }}>Open in editor loads one library into the Functions tab without saving. Save selected stores each checked library on the server: as a new library (v1.001) or as the next sub-version of an existing one.</p>
          </div>
          <div className="mf">
            <button type="button" onClick={() => setImp(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={!imp.libs.some((l) => l.on)} onClick={async () => {
              let n = 0;
              try {
                for (const l of imp.libs.filter((x) => x.on)) {
                  const data: PyLibDraft = { name: l.name, code: l.code, ...(l.tries ? { tries: l.tries } : {}) };
                  const meta = { functions: sigs(l.code).length, rows: l.code.split("\n").length, cols: sigs(l.code).length };
                  let id = l.target;
                  let v: Ver = { major: 1, minor: 1 };
                  if (id === "new") id = (await api.pyLibs.create({ name: l.name || "Imported library" })).id;
                  else {
                    const it = items.find((x) => x.id === id);
                    const lv = it && latest(it.versions);
                    if (lv) v = bumpMinor(lv, it!.versions);
                  }
                  await api.pyLibs.saveVersion(id, v.major, v.minor, { stamp: stamp(), data, meta });
                  const note = [l.notes, `Imported from ${imp.file}${l.version ? ` (v${l.version})` : ""}`].filter(Boolean).join(" · ");
                  await api.pyLibs.notes(id, v.major, v.minor, { notes: note }).catch(() => {});
                  n++;
                }
                ui.toast(`Saved ${n} librar${n === 1 ? "y" : "ies"}`);
                setImp(null);
              } catch (e) {
                ui.toast(`Import stopped after ${n}: ${(e as Error).message}`);
              }
              refresh();
            }}>Save selected ({imp.libs.filter((l) => l.on).length})</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ExportModal({ draft, items, onClose, onDone }: { draft: PyLibDraft; items: Versioned[]; onClose: () => void; onDone: (n: number, file: string) => void }) {
  const [useDraft, setUseDraft] = useState(true);
  const [pick, setPick] = useState<Record<string, { on: boolean; ver: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const n = (useDraft ? 1 : 0) + Object.values(pick).filter((p) => p.on).length;
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const libs: PyLibFileEntry[] = [];
      if (useDraft) libs.push({ name: draft.name || "Function library", version: null, notes: "Unsaved editor content", code: draft.code, functions: sigs(draft.code), tries: draft.tries });
      for (const it of items) {
        const p = pick[it.id];
        if (!p?.on) continue;
        const v = (p.ver ? it.versions.find((x) => verLabel(x) === p.ver) : undefined) ?? latest(it.versions);
        if (!v) continue;
        const full = await api.pyLibs.getVersion(it.id, v.major, v.minor);
        const d = full.data as PyLibDraft | null;
        const code = d?.code ?? "";
        libs.push({ name: it.name, version: verLabel(v), notes: v.notes ?? "", code, functions: sigs(code), tries: d?.tries });
      }
      const name = exportFileName(nowPrecise());
      downloadText(name, JSON.stringify(makeLibFile(libs), null, 2) + "\n");
      onDone(libs.length, name);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Export function libraries">
      <div className="mh"><h3>Export function libraries</h3><span className="muted">File: Jsoneditor_export_YYYYDDMM_HHMMSSssss.json</span></div>
      <div className="mb">
        <label className="ctl"><input type="checkbox" checked={useDraft} onChange={(e) => setUseDraft(e.target.checked)} /> The library open in the editor — <strong>{draft.name || "(unnamed)"}</strong> <span className="muted">({sigs(draft.code).length} function{sigs(draft.code).length === 1 ? "" : "s"}, unsaved changes included)</span></label>
        <table className="vt libfile">
          <thead><tr><th></th><th>Saved library</th><th>Version</th></tr></thead>
          <tbody>
            {items.map((it) => {
              const p = pick[it.id] ?? { on: false, ver: "" };
              const vs = it.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
              return (
                <tr key={it.id}>
                  <td><input type="checkbox" aria-label={`Export ${it.name}`} checked={p.on} onChange={(e) => setPick({ ...pick, [it.id]: { ...p, on: e.target.checked } })} /></td>
                  <td>{it.name}</td>
                  <td>
                    <select aria-label={`Version of ${it.name}`} value={p.ver} onChange={(e) => setPick({ ...pick, [it.id]: { on: true, ver: e.target.value } })}>
                      <option value="">Latest{latest(it.versions) ? ` (v${verLabel(latest(it.versions)!)})` : ""}</option>
                      {vs.map((v) => <option key={verLabel(v)} value={verLabel(v)}>v{verLabel(v)}{v.notes ? ` — ${v.notes.slice(0, 30)}` : ""}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
            {!items.length && <tr><td colSpan={3} className="muted">No saved libraries yet.</td></tr>}
          </tbody>
        </table>
        {err && <span className="chip err">{err}</span>}
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!n || busy} onClick={run}>{busy ? "Exporting…" : `Export ${n} librar${n === 1 ? "y" : "ies"}`}</button>
      </div>
    </Modal>
  );
}
