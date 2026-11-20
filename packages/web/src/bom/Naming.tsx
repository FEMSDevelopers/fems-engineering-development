import { aliasOf, DEFAULT_NAMING, DOC_KINDS, NAMING_PLACEHOLDERS, docFileName, latest, partDocNames, verLabel, type NamingStandard } from "@fpl/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg, type Versioned, type VersionSummary } from "../api";
import { stableJson } from "../snapshots";
import { Modal, useLocal, useUi } from "../ui";
import { VersionBar } from "../VersionBar";
import { useNamingDraft } from "./store";
import { useMfrAliases } from "./aliases";
import { PyEditor } from "./PyEditor";

export const NAMING_KEY = "fpl.snap.docnaming";
const SAMPLE = { manufacturer: "Phoenix Contact", partNumber: "2904602", series: "QUINT" };

/**
 * Saving, renaming or deleting a naming standard anywhere dispatches this event (and posts it to
 * other tabs); every picker then re-pulls the list and the rules, so a saved standard shows at once.
 */
export const NAMING_CHANGED = "fpl:naming-changed";
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("fpl-naming") : null;
export function notifyNamingChanged() {
  cache.clear();
  window.dispatchEvent(new Event(NAMING_CHANGED));
  channel?.postMessage("changed");
}
channel?.addEventListener("message", () => {
  cache.clear();
  window.dispatchEvent(new Event(NAMING_CHANGED));
});

/** Saved naming standards (variants with versions), most recently updated first; re-pulled when one is saved and when the window regains focus. */
export function useNamingStandards() {
  const [items, setItems] = useState<Versioned[]>([]);
  const refresh = useCallback(() => api.docNamings.list().then(setItems).catch(() => {}), []);
  useEffect(() => {
    refresh();
    window.addEventListener(NAMING_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(NAMING_CHANGED, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  return { items, refresh };
}
/** Rules of a saved version; cached per save time, so a version saved over is fetched again. */
const cache = new Map<string, NamingStandard>();
export async function loadNaming(id: string, major: number, minor: number, savedAt = ""): Promise<NamingStandard> {
  const k = `${id}|${major}|${minor}|${savedAt}`;
  if (!cache.has(k)) cache.set(k, { ...DEFAULT_NAMING, ...((await api.docNamings.getVersion(id, major, minor)).data as NamingStandard) });
  return cache.get(k)!;
}
/** Drop the cached rules (force update). */
export const clearNamingCache = () => cache.clear();

/**
 * Picker value: "" = built-in default; "id|latest" = always the latest version of that standard
 * (follows new sub-versions on its own); "id|major|minor" = a fixed version.
 */
export function resolveNaming(value: string, items: Versioned[]): { id: string; ver: VersionSummary } | null {
  if (!value) return null;
  const [id, a, b] = value.split("|");
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  const ver = a === "latest" ? latest(it.versions) : it.versions.find((v) => v.major === +a && v.minor === +b);
  return ver ? { id, ver } : null;
}
/** Picker "standard › Latest / version". */
export function NamingPicker({ items, value, onChange }: { items: Versioned[]; value: string; onChange: (v: string, label: string) => void }) {
  return (
    <select aria-label="Naming standard" value={value} onChange={(e) => onChange(e.target.value, e.target.selectedOptions[0]?.text ?? "")} style={{ maxWidth: 280 }}>
      <option value="">Built-in default</option>
      {items.map((x) => {
        const lv = latest(x.versions);
        return (
          <optgroup key={x.id} label={x.name}>
            {lv && <option value={`${x.id}|latest`}>{x.name} — latest (v{verLabel(lv)})</option>}
            {x.versions.map((v) => <option key={`${v.major}.${v.minor}`} value={`${x.id}|${v.major}|${v.minor}`}>{x.name} v{verLabel(v)}{v.notes ? ` — ${v.notes.slice(0, 24)}` : ""}</option>)}
          </optgroup>
        );
      })}
    </select>
  );
}
/** Default: the latest version of the most recently updated standard (following new versions). */
export const defaultNamingValue = (items: Versioned[]) => {
  const x = items[0];
  return x && latest(x.versions) ? `${x.id}|latest` : "";
};
/** Rules of a picker value, resolved against the current list (latest = newest version now). */
export function useNamingRules(value: string, items: Versioned[]): NamingStandard {
  const r = resolveNaming(value, items);
  const key = r ? `${r.id}|${r.ver.major}|${r.ver.minor}|${r.ver.savedAt}` : "";
  const [std, setStd] = useState<NamingStandard>(DEFAULT_NAMING);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const f = () => setBump((n) => n + 1);
    window.addEventListener(NAMING_CHANGED, f);
    return () => window.removeEventListener(NAMING_CHANGED, f);
  }, []);
  useEffect(() => {
    if (!r) return setStd(DEFAULT_NAMING);
    loadNaming(r.id, r.ver.major, r.ver.minor, r.ver.savedAt).then(setStd).catch(() => setStd(DEFAULT_NAMING));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bump]);
  return std;
}
/** The standard Edit part → Documents uses for its "Standard name" column (the picker there, else the latest standard). */
/**
 * Every document type: the built-in kinds, then the types defined in the naming standards (rules of
 * the latest version of every saved standard, plus `extra` — e.g. a project's imported copy), then
 * "Other" last, plus the types of the open (unsaved) draft of the Document naming standards window. Re-pulled whenever a
 * standard is saved, renamed or deleted (and on window focus); the draft is live, so a type typed there appears in every
 * Kind list at once.
 */
export function mergeDocKinds(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const l of lists) for (const k of l ?? []) {
    const t = k.trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  const all = [...seen.values()].filter((k) => k.toLowerCase() !== "other");
  return [...all, "Other"];
}
export function useDocKinds(extra?: readonly string[]): string[] {
  const { items } = useNamingStandards();
  // The Document naming standards window's open draft (live, saved or not): a type typed there shows at once.
  const [draft] = useNamingDraft();
  const [kinds, setKinds] = useState<string[]>([]);
  const key = items.map((x) => {
    const v = latest(x.versions);
    return v ? `${x.id}|${v.major}|${v.minor}|${v.savedAt}` : "";
  }).join(",");
  useEffect(() => {
    let live = true;
    Promise.all(items.map((x) => {
      const v = latest(x.versions);
      return v ? loadNaming(x.id, v.major, v.minor, v.savedAt).then((s) => s.rules.map((r) => r.kind)).catch(() => []) : Promise.resolve([] as string[]);
    })).then((ls) => live && setKinds(ls.flat()));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return mergeDocKinds(DOC_KINDS, kinds, draft.rules.map((r) => r.kind), extra);
}
/** <option>s of a Kind select: every document type, plus the current value when it is not (or no longer) defined. */
export function KindOptions({ kinds, value }: { kinds: string[]; value?: string }) {
  const l = value && !kinds.some((k) => k.toLowerCase() === value.toLowerCase()) ? [...kinds, value] : kinds;
  return <>{l.map((k) => <option key={k} value={k}>{k}</option>)}</>;
}

export const NAMING_PICK_KEY = "fpl.bom.namingpick";
export function useEditPartStandard(): { std: NamingStandard; label: string } {
  const { items } = useNamingStandards();
  const [stdVal] = useLocal<string>(NAMING_PICK_KEY, "");
  const pick = stdVal && resolveNaming(stdVal, items) ? stdVal : defaultNamingValue(items);
  const std = useNamingRules(pick, items);
  const r = resolveNaming(pick, items);
  const x = r && items.find((i) => i.id === r.id);
  return { std, label: x && r ? `${x.name} v${verLabel(r.ver)}` : "built-in default" };
}
/** Rules of a picker value (fetches the list when "latest" has to be resolved). */
export async function namingFromValue(v: string, items?: Versioned[]): Promise<NamingStandard> {
  if (!v) return DEFAULT_NAMING;
  const r = resolveNaming(v, items ?? (await api.docNamings.list()));
  return r ? loadNaming(r.id, r.ver.major, r.ver.minor, r.ver.savedAt) : DEFAULT_NAMING;
}

/** Values the examples are built from: the part being edited and its documents (prefix / suffix / title), else a sample. */
export interface NamingSample {
  part: { manufacturer: string; partNumber: string; series?: string };
  sub?: string;
  docs?: { kind: string; title: string; fileName: string; prefix?: string; suffix?: string; ref?: string }[];
}
/** Rules editor: one pattern per document type, with a live example. */
export function NamingRules({ std, onChange, sample: smp }: { std: NamingStandard; onChange: (s: NamingStandard) => void; sample?: NamingSample }) {
  const ui = useUi();
  const aliases = useMfrAliases();
  const allKinds = useDocKinds();
  const sp = smp?.part.partNumber ? smp.part : SAMPLE;
  const sample = { ...sp, mfrAlias: aliasOf(aliases, sp.manufacturer) };
  const sub = smp?.sub ?? "24VDC Power Supply";
  /** The part's own document of a kind (or its first document), else a sample with a prefix and suffix. */
  const docFor = (kind: string) => {
    const d = smp?.docs?.find((x) => x.kind.toLowerCase() === kind.toLowerCase()) ?? smp?.docs?.find((x) => x.prefix || x.suffix) ?? smp?.docs?.[0];
    return d ? { ...d, kind, fileName: d.fileName || "x.pdf" } : { kind, title: "Datasheet", fileName: "x.pdf", ref: kind === "Certificate" ? "cert:UL 61010-1" : "", prefix: "SUB-001", suffix: "REV A" };
  };
  const [focus, setFocus] = useState(0);
  const setRule = (i: number, patch: Partial<NamingStandard["rules"][number]>) => onChange({ ...std, rules: std.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="naming">
      <div className="frow tight">
        <label className="f">Case<select value={std.case} onChange={(e) => onChange({ ...std, case: e.target.value as NamingStandard["case"] })}><option value="upper">UPPER</option><option value="lower">lower</option><option value="asis">As typed</option></select></label>
        <label className="f">Separator<select value={std.sep} onChange={(e) => onChange({ ...std, sep: e.target.value as NamingStandard["sep"] })}><option value="_">_ underscore</option><option value="-">- hyphen</option><option value=" ">space</option></select></label>
        <label className="f">Max length<input type="number" min={20} max={250} value={std.maxLen} onChange={(e) => onChange({ ...std, maxLen: Math.max(20, Math.min(250, Number(e.target.value) || 120)) })} style={{ width: 80 }} /></label>
        <label className="f" style={{ flex: 2 }}>Pattern for other types<input type="text" className="mono" value={std.defaultPattern} onFocus={() => setFocus(0)} onChange={(e) => onChange({ ...std, defaultPattern: e.target.value })} /></label>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Placeholders: {NAMING_PLACEHOLDERS.map((p) => <code key={p}>{`{${p}}`}</code>)} — the file extension is kept; a document's prefix / suffix is added at the start / end when the pattern has no {"{prefix}"} / {"{suffix}"}.
        Examples use {smp?.part.partNumber ? <b>{sample.manufacturer} {sample.partNumber}{smp.docs?.length ? " and its documents" : ""}</b> : "a sample part"}. Other types: <code>{docFileName(std, docFor("Other"), sample, { sub })}</code></p>
      <table className="mini wide">
        <thead><tr><th>Document type</th><th>Code</th><th>Pattern</th><th>Example</th><th /></tr></thead>
        <tbody>
          {std.rules.map((r, i) => (
            <tr key={i}>
              <td><input type="text" list="naming-kinds" value={r.kind} onChange={(e) => setRule(i, { kind: e.target.value })} style={{ width: 150 }} /></td>
              <td><input type="text" className="mono" value={r.code} onChange={(e) => setRule(i, { code: e.target.value })} style={{ width: 60 }} /></td>
              <td><input type="text" className="mono" value={r.pattern} onFocus={() => setFocus(i + 1)} onChange={(e) => setRule(i, { pattern: e.target.value })} style={{ width: "100%", minWidth: 260 }} /></td>
              <td className="mono muted" style={{ fontSize: 11.5 }}>{docFileName(std, docFor(r.kind), sample, { sub })}</td>
              <td><button type="button" className="btn-ghost btn-danger" aria-label={`Delete rule ${r.kind}`} onClick={() => onChange({ ...std, rules: std.rules.filter((_, j) => j !== i) })}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <PyEditor
        mode="naming"
        multiline={false}
        label={focus === 0 || !std.rules[focus - 1] ? "Pattern for other types" : `Pattern for ${std.rules[focus - 1].kind}`}
        value={focus === 0 || !std.rules[focus - 1] ? std.defaultPattern : std.rules[focus - 1].pattern}
        onChange={(v) => (focus === 0 || !std.rules[focus - 1] ? onChange({ ...std, defaultPattern: v }) : setRule(focus - 1, { pattern: v }))}
        part={{ manufacturer: sample.manufacturer, partNumber: sample.partNumber, series: sample.series }}
        sub={sub}
        namingDoc={docFor(focus === 0 || !std.rules[focus - 1] ? "Other" : std.rules[focus - 1].kind)}
      />
      <datalist id="naming-kinds">{mergeDocKinds(allKinds, std.rules.map((r) => r.kind)).map((k) => <option key={k} value={k} />)}</datalist>
      <div className="toolbar">
        <button type="button" onClick={async () => {
          const k = await ui.prompt("Document type (added to every Kind list once the standard is saved)", "", "Add");
          if (k) onChange({ ...std, rules: [...std.rules, { kind: k, code: k.slice(0, 3).toUpperCase(), pattern: std.defaultPattern }] });
        }}>+ Document type</button>
        <button type="button" className="btn-ghost" onClick={() => onChange(structuredClone(DEFAULT_NAMING))}>Reset to built-in default</button>
      </div>
    </div>
  );
}

/** The shared library of naming standards: edit and save as versions / sub-versions, rename, delete. */
export function NamingStandardsModal({ onClose, onChanged, sample }: { onClose: () => void; onChanged?: () => void; sample?: NamingSample }) {
  const ui = useUi();
  const [draft, setDraft] = useNamingDraft();
  const [barKey, setBarKey] = useState(0);
  const first = useRef(true);
  return (
    <Modal onClose={onClose} label="Document naming standards">
      <div className="mh">
        <h3>Document naming standards</h3>
        <VersionBar<NamingStandard>
          key={barKey}
          storageKey={NAMING_KEY}
          store={api.docNamings}
          noun="naming standard"
          data={draft}
          canon={stableJson}
          defaultName="Fractal document naming"
          describe={(d) => ({ rules: d.rules.length })}
          restore={async (d) => setDraft({ ...DEFAULT_NAMING, ...d })}
          onItems={() => {
            // The bar reloads its list after every save / rename / delete: re-pull the rules everywhere.
            if (first.current) first.current = false;
            else notifyNamingChanged();
            onChanged?.();
          }}
        />
        <button type="button" onClick={async () => {
          if (!(await ui.confirm("Start a new naming standard from the built-in default? Unsaved changes are lost.", "New"))) return;
          localStorage.setItem(NAMING_KEY, JSON.stringify({ id: null, loaded: null, pending: { major: 1, minor: 1 }, savedHash: null }));
          setDraft(structuredClone(DEFAULT_NAMING));
          setBarKey((k) => k + 1);
        }}>New</button>
      </div>
      <div className="mb">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>One standard for every project and OEM. Save a sub-version (+.001) for small changes and a new version (+1.) for a new convention; projects import a version and can adjust it.</p>
        <NamingRules std={draft} onChange={setDraft} sample={sample} />
      </div>
      <div className="mf"><button type="button" className="btn-primary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

/** Rename the stored files of one part's documents with a standard. */
export async function renamePartDocs(std: NamingStandard, docs: { id: string; kind: string; title: string; fileName: string; prefix?: string; suffix?: string; ref?: string }[], part: { manufacturer: string; partNumber: string; series?: string; mfrAlias?: string }, sub?: string) {
  // Names over every document (links included, as in the Standard name column); only stored files are renamed.
  const names = partDocNames(std, docs, part, sub);
  let n = 0;
  try {
    for (let i = 0; i < docs.length; i++)
      if (docs[i].fileName && names[i] !== docs[i].fileName) {
        await api.parts.updateDoc(docs[i].id, { fileName: names[i] });
        n++;
      }
  } catch (e) {
    throw new Error(errMsg(e));
  }
  return n;
}

/**
 * Open the standards editor on a standard / version: loads it into the editor draft and makes it the
 * editor's current version (so Save writes a new sub-version of it).
 */
export async function openNamingInEditor(id: string, ver: VersionSummary, setDraft: (s: NamingStandard) => void) {
  const full = await api.docNamings.getVersion(id, ver.major, ver.minor);
  const d = { ...DEFAULT_NAMING, ...(full.data as NamingStandard) };
  setDraft(d);
  const v = { major: ver.major, minor: ver.minor };
  try {
    localStorage.setItem(NAMING_KEY, JSON.stringify({ id, loaded: v, pending: v, savedHash: stableJson(d) }));
  } catch {
    /* ignore */
  }
}

/** Naming standard of Edit part → Documents: picker plus Edit…, Delete… and ↻ Re-pull (force update). */
export function NamingStandardBar({ items, value, onChange, refresh, sample }: {
  items: Versioned[]; value: string; onChange: (v: string) => void; refresh: () => Promise<unknown> | void; sample?: NamingSample;
}) {
  const ui = useUi();
  const [, setDraft] = useNamingDraft();
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const r = resolveNaming(value, items);
  const it = r ? items.find((x) => x.id === r.id) : undefined;
  const openEdit = async () => {
    try {
      if (r) await openNamingInEditor(r.id, r.ver, setDraft);
      setEdit(true);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const repull = async () => {
    clearNamingCache();
    await refresh();
    notifyNamingChanged();
    ui.toast("Naming standards re-pulled from the database");
  };
  return (
    <>
      <span className="muted" style={{ fontSize: 12.5 }}>Naming standard</span>
      <NamingPicker items={items} value={value} onChange={(v) => onChange(v)} />
      <button type="button" className="btn-ghost" onClick={openEdit} title={it ? `Edit ${it.name} (opens on v${verLabel(r!.ver)}; Save makes the next sub-version)` : "Edit or create naming standards"}>Edit…</button>
      <button type="button" className="btn-ghost" disabled={!it} onClick={() => setDel(true)} title="Delete this version or the whole standard">Delete…</button>
      <button type="button" className="btn-ghost" onClick={repull} title="Force update: re-pull the standards and their rules from the database">↻ Re-pull</button>
      {edit && <NamingStandardsModal onClose={() => (setEdit(false), void refresh())} onChanged={() => void refresh()} sample={sample} />}
      {del && it && r && (
        <Modal onClose={() => setDel(false)} label="Delete naming standard" size="sm">
          <div className="mh"><h3>Delete {it.name}?</h3></div>
          <div className="mb">
            <p style={{ margin: 0 }}>Delete only <b>v{verLabel(r.ver)}</b>, or the whole standard with its {it.versions.length} version(s)? Documents keep their current file names; projects that imported a copy keep it.</p>
          </div>
          <div className="mf">
            <button type="button" onClick={() => setDel(false)}>Cancel</button>
            <button type="button" className="btn-danger" disabled={it.versions.length < 2} title={it.versions.length < 2 ? "It is the only version: delete the standard" : undefined} onClick={async () => {
              try {
                await api.docNamings.removeVersion(it.id, r.ver.major, r.ver.minor);
                setDel(false);
                if (!value.endsWith("|latest")) onChange(`${it.id}|latest`);
                await refresh();
                notifyNamingChanged();
                ui.toast(`Deleted ${it.name} v${verLabel(r.ver)}`);
              } catch (e) {
                ui.toast(errMsg(e));
              }
            }}>Delete v{verLabel(r.ver)}</button>
            <button type="button" className="btn-danger" onClick={async () => {
              try {
                await api.docNamings.remove(it.id);
                setDel(false);
                onChange("");
                await refresh();
                notifyNamingChanged();
                ui.toast(`Deleted ${it.name}`);
              } catch (e) {
                ui.toast(errMsg(e));
              }
            }}>Delete the standard</button>
          </div>
        </Modal>
      )}
    </>
  );
}
