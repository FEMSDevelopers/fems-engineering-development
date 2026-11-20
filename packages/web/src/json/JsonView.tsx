import {
  arrayElements, checkCell, codeNames, condPalette, elementKeys, emptyCond, emptyInstance, exprNames, fmtDateTime, instanceMeta, legacyOutputs, guessColType, JS_COL_TYPES, JS_OUT_TYPES, latest, sameVer,
  lookupFns, parseCode, parseDelimited, parseExpr, parseJson, parsePath, runCond, scanJson, shortJson, tableIssues, verLabel,
  type JsColType, type JsCond, type JsField, type JsInstance, type JsKey, type JsNode, type JsOutType, type JsSource, type JsTableData, type PlRule, type Ver,
} from "@fpl/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppFolder, type CondItem, type InstanceItem, type Versioned, type VersionedStore } from "../api";
import { folderTree, InstancesTab, NewInstanceModal } from "./Instances";
import { stableJson } from "../snapshots";
import { useVersionData } from "./hooks";
import { PY_SNIPPETS, RuleChain, type Snip } from "../sources/PointListBuilder";
import { HoldButton, Modal, Seg, useLocal, useUi } from "../ui";
import { loadVersionDirect, saveSubversionDirect, VersionBar, versionPointer, type VersionBarHandle } from "../VersionBar";
import { BLANK_LIB, EMPTY_LIB, FunctionsEditor, FunctionsPalette, LibFileTools, LibPicker, mergeLibs, useLibCodes, useLibItems, type PyLibDraft } from "../pylibs";

type Tab = "instances" | "sources" | "structure" | "array" | "output" | "functions";
const INST_KEY = "fpl.json.lib.inst";
/** The instance open in the editor (its document is the draft of 1 Sources). */
interface OpenInst {
  open: boolean;
  id: string | null;
  name: string;
  folderId: string | null;
}
const NO_INST: OpenInst = { open: false, id: null, name: "", folderId: null };
/** An instance is its document; conditioning sets are saved on their own. */
const canonInst = (d: JsInstance) => stableJson({ source: d.source });
interface Sel {
  /** Saved JSON source id, or "draft" for the source being edited in tab 1. */
  sourceId: string | null;
  /** null = latest version */
  ver: Ver | null;
  path: string;
}
const EMPTY_SRC: JsSource = { kind: "json", name: "", text: "" };
/** The array a saved conditioning was made for (stored with the conditioning). */
interface CondArray {
  path: string;
  /** Saved JSON source; null when the conditioning was saved on the unsaved draft. */
  sourceId: string | null;
  ver: Ver | null;
  sourceName?: string;
}
/** Conditioning template a set was created from (recorded when the set is saved). */
interface CondBase {
  id: string;
  ver: Ver | null;
  name: string;
}
type CondSaved = JsCond & { array?: CondArray; basedOn?: CondBase | null };
const COND_KEY = "fpl.json.lib.cond";
const condEmpty = (d: JsCond) => !d.fields.length && !d.lookups.length && !(d.libs ?? []).length;
interface Pointer {
  id: string | null;
  loaded: Ver | null;
}
const EMPTY_SEL: Sel = { sourceId: "draft", ver: null, path: "" };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).slice(0, 8);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const move = <T,>(l: T[], i: number, d: -1 | 1) => {
  const j = i + d;
  if (j < 0 || j >= l.length) return l;
  const c = l.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
};
const download = (name: string, text: string, type: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
/** "meta.unit" → el["meta"]["unit"] */
const pyPath = (base: string, path: string) =>
  path ? base + path.split(/\.(?![^[]*\])/).map((p) => (p.startsWith("[") ? p : `[${JSON.stringify(p)}]`)).join("") : base;

export function JsonView({ active }: { active: boolean }) {
  const [tab, setTab] = useLocal<Tab>("fpl.json.tab", "instances");
  const [src, setSrc] = useLocal<JsSource>("fpl.json.src", EMPTY_SRC);
  const [sel, setSel] = useLocal<Sel>("fpl.json.sel", EMPTY_SEL);
  const [cond, setCond] = useLocal<JsCond>("fpl.json.cond", emptyCond());
  const [focus, setFocus] = useLocal<number>("fpl.json.focus", 0);
  const [libDraft, setLibDraft] = useLocal<PyLibDraft>("fpl.json.libdraft", EMPTY_LIB);
  const lib = useLibItems(active, tab);
  /** Bumped when a new source is started, so its version controls start detached. */
  const [srcEpoch, setSrcEpoch] = useState(0);
  const detachSource = () => {
    try {
      localStorage.removeItem("fpl.json.lib.src");
    } catch {
      /* ignore */
    }
    setSrcEpoch((n) => n + 1);
  };
  const [items, setItems] = useState<Versioned[]>([]);
  const refresh = useCallback(() => api.jsonSources.list().then(setItems).catch(() => {}), []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh, tab]);
  const [condItems, setCondItems] = useState<CondItem[]>([]);
  const refreshConds = useCallback(() => api.jsonConds.list().then(setCondItems).catch(() => {}), []);
  useEffect(() => {
    if (active) refreshConds();
  }, [active, refreshConds, tab]);
  const [condCur, setCondCur] = useState<Pointer>(() => versionPointer(COND_KEY));
  const [srcCur, setSrcCur] = useState<Pointer>(() => versionPointer("fpl.json.lib.src"));
  const srcBar = useRef<VersionBarHandle>(null);
  /** Bumped when a saved conditioning is picked in Structure, to highlight the selected array. */
  const [flash, setFlash] = useState(0);
  // Departments / folders and instances.
  const [folders, setFolders] = useState<AppFolder[]>([]);
  const [instItems, setInstItems] = useState<InstanceItem[]>([]);
  const refreshInst = useCallback(() => {
    api.folders.list().then(setFolders).catch(() => {});
    api.jsonInstances.list().then((x) => setInstItems(x as InstanceItem[])).catch(() => {});
  }, []);
  useEffect(() => {
    if (active) refreshInst();
  }, [active, refreshInst, tab]);
  const [inst, setInst] = useLocal<OpenInst>("fpl.json.inst", NO_INST);
  const [instEpoch, setInstEpoch] = useState(0);
  const [instHash, setInstHash] = useState<string | null>(() => {
    try {
      return (JSON.parse(localStorage.getItem(INST_KEY) ?? "{}") as { savedHash?: string }).savedHash ?? null;
    } catch {
      return null;
    }
  });
  const [saveAsInst, setSaveAsInst] = useState(false);
  const kindOf = (it: Versioned) => (latest(it.versions)?.meta as { kind?: string } | undefined)?.kind;
  const jsonItems = items.filter((x) => kindOf(x) === "json");
  const tableItems = items.filter((x) => kindOf(x) === "table");

  // Document of the selection (draft or a saved source).
  const [selData] = useVersionData<JsSource>(api.jsonSources, [{ id: sel.sourceId === "draft" ? null : sel.sourceId, ver: sel.ver }], items);
  const docText = sel.sourceId === "draft" ? (src.kind === "json" ? src.text ?? "" : "") : selData?.data?.text ?? "";
  const parsed = useMemo(() => (docText.trim() ? parseJson(docText) : null), [docText]);
  const doc = parsed?.ok ? parsed.value : undefined;
  const nodes = useMemo(() => (doc === undefined ? [] : scanJson(doc)), [doc]);
  const elems = useMemo(() => (doc !== undefined && sel.path ? arrayElements(doc, sel.path) : []), [doc, sel.path]);

  // Lookup tables used by the conditioning.
  const lk = useVersionData<JsSource>(api.jsonSources, cond.lookups.map((l) => ({ id: l.sourceId, ver: l.ver })), items);
  const tables = useMemo(() => {
    const t: Record<string, JsTableData> = {};
    cond.lookups.forEach((l, i) => {
      const d = lk[i]?.data;
      if (l.alias.trim() && d?.kind === "table") t[l.alias.trim()] = { columns: d.columns ?? [], rows: d.rows ?? [] };
    });
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cond.lookups, lk.map((x) => x.key + (x.data ? "+" : "")).join("|")]);

  // Function libraries of the conditioning (they can call lookup(), rows() …).
  const { codes: libCodes } = useLibCodes(cond.libs ?? [], lib.items, libDraft.code);
  const baseFns = useMemo(() => lookupFns(tables), [tables]);
  const libs = useMemo(() => mergeLibs(libCodes, baseFns), [libCodes.join("\u0000"), baseFns]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs: [Tab, string][] = [
    ["instances", "Instances"],
    ["sources", "1 Sources"],
    ["structure", `2 Structure${nodes.length ? ` (${nodes.filter((n) => n.kind === "array").length} arrays)` : ""}`],
    ["array", `3 Array & conditioning${elems.length ? ` (${elems.length})` : ""}`],
    ["output", "4 Output"],
    ["functions", "5 Functions"],
  ];
  const srcName = sel.sourceId === "draft" ? `draft${src.name ? ` “${src.name}”` : ""}` : items.find((x) => x.id === sel.sourceId)?.name ?? "—";
  // The conditioning is saved together with the array it was made for.
  const [condBase, setCondBase] = useLocal<CondBase | null>("fpl.json.condBase", null);
  const [condEpoch, setCondEpoch] = useState(0);
  const [newSet, setNewSet] = useState(false);
  const condData = useMemo<CondSaved>(() => ({
    ...cond,
    ...(condBase ? { basedOn: condBase } : {}),
    array: { path: sel.path, sourceId: sel.sourceId === "draft" ? null : sel.sourceId, ver: sel.ver, sourceName: sel.sourceId === "draft" ? src.name || undefined : srcName },
  }), [cond, condBase, sel.path, sel.sourceId, sel.ver, src.name, srcName]);
  const restoreCond = (d: CondSaved) => {
    const { array, basedOn, ...c } = d;
    setCond({ ...emptyCond(), ...c });
    setCondBase(basedOn ?? null);
    if (array?.path) {
      const known = !!array.sourceId && jsonItems.some((x) => x.id === array.sourceId);
      setSel((p) => ({ sourceId: known ? array.sourceId : p.sourceId, ver: known ? array.ver : p.ver, path: array.path }));
    }
  };
  const ui = useUi();
  const pickCond = async (id: string, v: Ver) => {
    const ok = await loadVersionDirect<CondSaved>({
      storageKey: COND_KEY, store: api.jsonConds, noun: "conditioning", id, ver: v, current: condData, isEmpty: condEmpty, canon: stableJson,
      restore: restoreCond, confirm: ui.confirm,
    }).catch((e) => (ui.toast(`Couldn’t load: ${(e as Error).message}`), false));
    if (!ok) return;
    setCondCur({ id, loaded: v });
    setFlash((n) => n + 1);
    ui.toast(`Loaded conditioning ${condItems.find((x) => x.id === id)?.name ?? ""} v${verLabel(v)}`);
  };
  // ---- instance open in the editor
  const instData = useMemo<JsInstance | null>(() => (inst.open ? { source: { name: sel.sourceId === "draft" ? src.name : srcName, text: docText } } : null), [inst.open, sel.sourceId, src.name, srcName, docText]);
  const instDirty = !!instData && canonInst(instData) !== instHash;
  /** Start an empty, detached conditioning (array kept). */
  const resetCond = () => {
    setCond(emptyCond());
    setCondBase(null);
    try {
      localStorage.removeItem(COND_KEY);
    } catch {
      /* ignore */
    }
    setCondCur({ id: null, loaded: null });
    setCondEpoch((n) => n + 1);
  };
  /** Replace the editor document with an instance's. */
  const applyInstance = (d0: JsInstance) => {
    const d = { ...emptyInstance(), ...d0 };
    setSrc({ kind: "json", name: d.source?.name ?? "", text: d.source?.text ?? "" });
    detachSource();
    setSel((p) => ({ sourceId: "draft", ver: null, path: p.path }));
    setFocus(0);
    setInst((p) => ({ ...p, open: true }));
    setInstHash(canonInst(d));
  };
  /** Pre-r25 instances kept outputs inside the instance: save them as conditioning sets of the instance. */
  const convertLegacy = async (id: string, d: JsInstance) => {
    const outs = legacyOutputs(d);
    if (!outs.length) return;
    if (!(await ui.confirm(`This instance has ${plural(outs.length, "output")} saved in the old format. Save ${outs.length === 1 ? "it" : "them"} as conditioning sets of the instance?`, "Convert"))) return;
    for (const o of outs) {
      const data: CondSaved = { ...emptyCond(), ...o.cond, array: { path: o.path, sourceId: null, ver: null, sourceName: d.source?.name || undefined } };
      const c = await api.jsonConds.create({ name: o.name, instanceId: id } as Partial<CondItem> & { name: string });
      await api.jsonConds.saveVersion(c.id, 1, 1, { stamp: new Date().toISOString(), data, meta: { fields: data.fields.length, lookups: data.lookups.length, rows: data.fields.length, cols: data.lookups.length, path: o.path, source: d.source?.name ?? "" } });
      await api.jsonConds.notes(c.id, 1, 1, { notes: "Converted from an instance output" }).catch(() => {});
    }
    // The instance keeps only its document from now on.
    await saveSubversionDirect<JsInstance>({ storageKey: INST_KEY, store: api.jsonInstances, noun: "instance", data: { source: d.source }, canon: canonInst, describe: instanceMeta, note: "Outputs converted to conditioning sets" });
    setInstHash(canonInst(d));
    refreshInst();
    await refreshConds();
    ui.toast(`Converted ${plural(outs.length, "output")} to conditioning sets`);
  };
  const openInstance = async (id: string, v: Ver, condId?: string, goto?: Tab) => {
    const it = instItems.find((x) => x.id === id);
    if (!(inst.open && inst.id === id)) {
      let loaded: JsInstance | null = null;
      const ok = await loadVersionDirect<JsInstance>({
        storageKey: INST_KEY, store: api.jsonInstances, noun: "instance", id, ver: v, current: instData, canon: canonInst,
        restore: (d) => ((loaded = d), applyInstance(d)), confirm: ui.confirm,
      }).catch((e) => (ui.toast(`Couldn’t open: ${(e as Error).message}`), false));
      if (!ok) return;
      setInst({ open: true, id, name: it?.name ?? "", folderId: it?.folderId ?? null });
      setInstEpoch((n) => n + 1);
      ui.toast(`Opened instance ${it?.name ?? ""} v${verLabel(v)}`);
      if (loaded) await convertLegacy(id, loaded).catch((e) => ui.toast(`Couldn’t convert: ${(e as Error).message}`));
      // Show the requested conditioning set, else the latest one of the instance (or start empty).
      const list = await api.jsonConds.list().catch(() => condItems);
      setCondItems(list);
      const target = condId ? list.find((c) => c.id === condId) : list.filter((c) => c.instanceId === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const tv = target && latest(target.versions);
      if (target && tv) await pickCond(target.id, tv);
      else resetCond();
    } else if (condId && condId !== condCur.id) {
      const target = condItems.find((c) => c.id === condId);
      const tv = target && latest(target.versions);
      if (target && tv) await pickCond(target.id, tv);
    }
    if (goto) setTab(goto);
  };
  const closeInstance = async () => {
    if (instDirty && !(await ui.confirm("The instance document has unsaved changes. Close it anyway? (The editor keeps its content as a draft.)", "Close"))) return;
    setInst(NO_INST);
    try {
      localStorage.removeItem(INST_KEY);
    } catch {
      /* ignore */
    }
  };
  const ft = folderTree(folders);
  // ---- function libraries: start a new one
  const libBar = useRef<VersionBarHandle>(null);
  const [libEpoch, setLibEpoch] = useState(0);
  const newLib = async () => {
    const saved = (() => {
      try {
        return (JSON.parse(localStorage.getItem("fpl.json.lib.py") ?? "{}") as { savedHash?: string }).savedHash ?? null;
      } catch {
        return null;
      }
    })();
    const pristine = [EMPTY_LIB, BLANK_LIB].some((x) => stableJson({ ...x, name: libDraft.name }) === stableJson(libDraft));
    if (stableJson(libDraft) !== saved && libDraft.code.trim() && !pristine && !(await ui.confirm("Start a new function library? The code in the editor has unsaved changes (saved versions are kept).", "New library"))) return;
    setLibDraft({ ...BLANK_LIB });
    try {
      localStorage.removeItem("fpl.json.lib.py");
    } catch {
      /* ignore */
    }
    setLibEpoch((n) => n + 1);
  };
  // Name and folder of the open instance follow renames / moves made in the Instances tab.
  const openItem = inst.id ? instItems.find((x) => x.id === inst.id) : undefined;
  const instFolder = openItem ? openItem.folderId : inst.folderId;
  const instName = openItem?.name ?? inst.name;
  const createFromEditor = async (name: string, folderId: string | null) => {
    const data: JsInstance = instData ?? { source: { name: sel.sourceId === "draft" ? src.name : srcName, text: docText } };
    const it = await api.jsonInstances.create({ name, folderId } as Partial<InstanceItem> & { name: string });
    const v = { major: 1, minor: 1 };
    await api.jsonInstances.saveVersion(it.id, 1, 1, { stamp: new Date().toISOString(), data, meta: instanceMeta(data) });
    // The conditioning in the editor becomes the instance's first set (a library template stays in the library and is copied).
    const curItem = condItems.find((c) => c.id === condCur.id);
    if (curItem && !curItem.instanceId) {
      await api.jsonConds.setInstance(curItem.id, it.id);
    } else if (!condEmpty(cond)) {
      const c = await api.jsonConds.create({ name: `${name} rules`, instanceId: it.id } as Partial<CondItem> & { name: string });
      await api.jsonConds.saveVersion(c.id, 1, 1, { stamp: new Date().toISOString(), data: condData, meta: { fields: cond.fields.length, lookups: cond.lookups.length, rows: cond.fields.length, cols: cond.lookups.length, path: sel.path, source: data.source.name } });
      localStorage.setItem(COND_KEY, JSON.stringify({ id: c.id, loaded: v, pending: v, savedHash: stableJson(condData) }));
      setCondCur({ id: c.id, loaded: v });
      setCondEpoch((n) => n + 1);
    }
    refreshConds();
    setSaveAsInst(false);
    refreshInst();
    try {
      localStorage.setItem(INST_KEY, JSON.stringify({ id: it.id, loaded: v, pending: v, savedHash: canonInst(data) }));
    } catch {
      /* ignore */
    }
    setInst({ open: true, id: it.id, name, folderId });
    setInstHash(canonInst(data));
    setInstEpoch((n) => n + 1);
    ui.toast(`Saved instance ${name} v1.001 in ${ft.crumb(folderId)}`);
  };

  /** Save a new conditioning set: the selected array plus the rules of 3 (or none), v1.001. */
  const createSet = async (name: string, from: "current" | "empty", notes: string) => {
    const base: CondBase | null = from === "current" && condCur.id ? { id: condCur.id, ver: condCur.loaded, name: condItems.find((x) => x.id === condCur.id)?.name ?? "" } : null;
    const rules: JsCond = from === "current" ? cond : emptyCond();
    const data: CondSaved = { ...rules, ...(base ? { basedOn: base } : {}), array: condData.array };
    try {
      const it = await api.jsonConds.create({ name, ...(inst.open && inst.id ? { instanceId: inst.id } : {}) } as Partial<CondItem> & { name: string });
      await api.jsonConds.saveVersion(it.id, 1, 1, { stamp: new Date().toISOString(), data, meta: { fields: data.fields.length, lookups: data.lookups.length, rows: data.fields.length, cols: data.lookups.length, path: data.array?.path ?? "", source: data.array?.sourceName ?? "", template: base ? `${base.name}${base.ver ? ` v${verLabel(base.ver)}` : ""}` : "" } });
      if (notes.trim()) await api.jsonConds.notes(it.id, 1, 1, { notes: notes.trim() });
      const v = { major: 1, minor: 1 };
      localStorage.setItem(COND_KEY, JSON.stringify({ id: it.id, loaded: v, pending: v, savedHash: stableJson(data) }));
      if (from === "empty") setCond(emptyCond());
      setCondBase(base);
      setCondCur({ id: it.id, loaded: v });
      setCondEpoch((n) => n + 1);
      refreshConds();
      setNewSet(false);
      ui.toast(`Saved conditioning set ${name} v1.001${base ? ` (from ${base.name})` : ""}`);
    } catch (e) {
      ui.toast(`Couldn’t save: ${(e as Error).message}`);
    }
  };
  const curCondItem = condItems.find((x) => x.id === condCur.id);
  const condLabel = curCondItem ? `${curCondItem.name}${condCur.loaded ? ` v${verLabel(condCur.loaded)}` : ""}` : "unsaved conditioning";
  const condName = inst.open
    ? `${inst.id ? instName : "unsaved instance"} › ${condLabel}`
    : condCur.id ? `${condItems.find((x) => x.id === condCur.id)?.name ?? "conditioning"}${condCur.loaded ? ` v${verLabel(condCur.loaded)}` : ""}` : "unsaved conditioning";

  return (
    <section className="view simple jsv" aria-label="JSON editor">
      <header className="toolbar df-row1">
        <h1>JSON editor</h1>
        <Seg label="Steps" value={tab} options={tabs} onChange={setTab} />
        <span className="grow" />
        {tab === "sources" && (
          <VersionBar<JsSource>
            key={srcEpoch}
            handle={srcBar}
            onItems={setItems}
            onCurrent={(id, loaded) => setSrcCur({ id, loaded })}
            storageKey="fpl.json.lib.src"
            store={api.jsonSources}
            noun="source"
            defaultName={src.name || (src.kind === "json" ? "JSON source" : "Lookup table")}
            data={src}
            canon={stableJson}
            restore={async (d) => setSrc({ ...EMPTY_SRC, ...d })}
            describe={(d) => ({ kind: d.kind, rows: d.kind === "table" ? d.rows?.length ?? 0 : (d.text ?? "").length, cols: d.kind === "table" ? d.columns?.length ?? 0 : 1 })}
          />
        )}
        {tab === "instances" && <span className="hint">Departments → instances → conditioning rules → content</span>}
        {inst.open && tab === "sources" && <span className="hint" title="These controls save shared source templates; the instance document is saved in the Instance bar below.">Library templates:</span>}
        {inst.open && (tab === "array" || tab === "structure") && <span className="hint" title="New sets saved here belong to the open instance; sets loaded from the library stay in the library.">Conditioning sets of {inst.id ? instName : "this instance"}:</span>}
        {(tab === "structure" || tab === "array") && (
          <button type="button" className={tab === "structure" ? "btn-primary" : undefined} disabled={!sel.path} onClick={() => setNewSet(true)}
            title={sel.path ? `New conditioning set for ${sel.path} (array + rules of 3, saved as v1.001)` : "Select an array first"}>+ New conditioning set</button>
        )}
        {(tab === "structure" || tab === "array") && (
          <VersionBar<CondSaved>
            key={`cond${condEpoch}`}
            storageKey={COND_KEY}
            store={api.jsonConds}
            noun="conditioning"
            defaultName="Tag conditioning"
            data={condData}
            canon={stableJson}
            restore={async (d) => restoreCond(d)}
            onItems={(x) => setCondItems(x as CondItem[])}
            onCurrent={(id, loaded) => setCondCur({ id, loaded })}
            createExtra={inst.open && inst.id ? { instanceId: inst.id } : undefined}
            describe={(d) => ({ fields: d.fields.length, lookups: d.lookups.length, rows: d.fields.length, cols: d.lookups.length, path: d.array?.path ?? "", source: d.array?.sourceName ?? "", template: d.basedOn ? `${d.basedOn.name}${d.basedOn.ver ? ` v${verLabel(d.basedOn.ver)}` : ""}` : "" })}
          />
        )}
        {tab === "functions" && (
          <>
            <button type="button" title="Start a new, empty function library (the next save creates a new library)" onClick={newLib}>New</button>
            <button type="button" title="Save the code (and Try it lines) as a new function library v1.001" onClick={() => libBar.current?.saveAsNew()}>Save as new…</button>
          </>
        )}
        {tab === "functions" && (
          <VersionBar<PyLibDraft>
            key={`lib${libEpoch}`}
            handle={libBar}
            storageKey="fpl.json.lib.py"
            store={api.pyLibs}
            noun="function library"
            defaultName={libDraft.name || "Function library"}
            data={libDraft}
            canon={stableJson}
            restore={async (d) => (setLibDraft({ ...d, name: d.name ?? "", code: d.code ?? "" }), lib.refresh())}
            describe={(d) => ({ functions: (d.code.match(/^\s*def\s/gm) ?? []).length, rows: d.code.split("\n").length, cols: (d.code.match(/^\s*def\s/gm) ?? []).length })}
          />
        )}
      </header>
      {tab !== "instances" && (
        <div className={`toolbar jsv-instbar${inst.open ? " open" : ""}`} aria-label="Instance">
          {inst.open ? (
            <>
              <span className="lbl">Instance</span>
              <span className="crumb" title={ft.crumb(instFolder)}>
                {ft.dept(instFolder) && <span className="dot" style={{ background: ft.dept(instFolder)?.options.color ?? "var(--muted)" }} />}
                <span className="muted">{ft.crumb(instFolder)} /</span> <strong>{inst.id ? instName : "(not saved)"}</strong>
              </span>
              <span className="ctl" title="Conditioning set loaded in 2 Structure / 3 Array & conditioning">Conditioning <span className={`chip ${curCondItem ? "info" : ""}`}>{condLabel}{curCondItem && curCondItem.instanceId !== inst.id ? " · library" : ""}</span></span>
              <span className="grow" />
              <VersionBar<JsInstance>
                key={`inst${instEpoch}`}
                storageKey={INST_KEY}
                store={api.jsonInstances}
                noun="instance"
                defaultName={instName || "Instance"}
                data={instData}
                canon={canonInst}
                restore={async (d) => applyInstance(d)}
                describe={instanceMeta}
                onItems={(x) => setInstItems(x as InstanceItem[])}
                onCurrent={(id, loaded) => {
                  if (loaded) {
                    try {
                      setInstHash((JSON.parse(localStorage.getItem(INST_KEY) ?? "{}") as { savedHash?: string }).savedHash ?? null);
                    } catch {
                      /* ignore */
                    }
                  }
                  if (id === inst.id) return;
                  if (id && !inst.id && instFolder) {
                    // Saved as a new instance from a detached bar: file it where the open one was.
                    void api.jsonInstances.move(id, instFolder).then(refreshInst);
                  }
                  const it = instItems.find((x) => x.id === id);
                  setInst((p) => ({ ...p, id, name: it?.name ?? p.name, folderId: it ? it.folderId : p.folderId }));
                }}
              />
              <button type="button" className="btn-ghost" onClick={closeInstance} title="Stop editing this instance (the editor keeps the content)">Close</button>
            </>
          ) : (
            <>
              <span className="muted">No instance open — the editor works on drafts. Open one in <button type="button" className="linkish" onClick={() => setTab("instances")}>Instances</button>, or</span>
              <button type="button" onClick={() => setSaveAsInst(true)} disabled={!docText.trim()}>Save as instance…</button>
            </>
          )}
        </div>
      )}
      {tab === "instances" && (
        <InstancesTab folders={folders} instances={instItems} refresh={refreshInst} open={{ id: inst.open ? inst.id : null, cond: condCur.id, dirty: instDirty }}
          editorData={instData ?? (docText.trim() ? { source: { name: sel.sourceId === "draft" ? src.name : srcName, text: docText } } : null)}
          srcItems={items} libItems={lib.items} draftCode={libDraft.code} conds={condItems} refreshConds={refreshConds}
          onOpen={(id, v, out, goto) => openInstance(id, v, out, goto)} />
      )}
      {newSet && (
        <NewSetModal path={sel.path} current={condCur.id ? `${condItems.find((x) => x.id === condCur.id)?.name ?? "conditioning"}${condCur.loaded ? ` v${verLabel(condCur.loaded)}` : ""}` : "unsaved rules"}
          fields={cond.fields.length} onCreate={createSet} onClose={() => setNewSet(false)} />
      )}
      {saveAsInst && <NewInstanceModal folders={folders} folderId={folders.find((f) => !f.parentId)?.id ?? null} canCopy title="Save the editor content as an instance" onCreate={(n, f) => createFromEditor(n, f)} onClose={() => setSaveAsInst(false)} />}
      {tab === "sources" && (
        <SourcesTab src={src} setSrc={setSrc} onNew={detachSource} onUse={() => (setSel({ ...sel, sourceId: "draft", ver: null }), setTab("structure"))}
          items={items} cur={srcCur} onPick={(id, v) => srcBar.current?.load(id, v, true)} />
      )}
      {tab === "structure" && (
        <StructureTab sel={sel} setSel={setSel} jsonItems={jsonItems} srcName={srcName} draftIsJson={src.kind === "json" && !!src.text?.trim()} parsed={parsed} doc={doc} nodes={nodes}
          onUse={() => setTab("array")} flash={flash}
          conds={<CondPanel items={condItems} cur={condCur} nodes={nodes} hasDoc={doc !== undefined} curPath={sel.path} onPick={pickCond} onTab={setTab}
            instanceId={inst.open ? inst.id : null} instanceName={instName} />} />
      )}
      {tab === "array" && (
        <ArrayTab sel={sel} doc={doc} elems={elems} cond={cond} setCond={setCond} tables={tables} tableItems={tableItems} libCodes={libCodes} libs={libs.libs} libItems={lib.items} refreshLibs={lib.refresh} draftCode={libDraft.code} focus={Math.min(focus, Math.max(0, elems.length - 1))} setFocus={setFocus}
          goStructure={() => setTab("structure")} />
      )}
      {tab === "output" && <OutputTab sel={sel} doc={doc} cond={cond} tables={tables} libCodes={libCodes} srcName={srcName} condName={condName} onSaved={refresh} />}
      {tab === "functions" && (
        <main className="plb-one">
          <FunctionsEditor draft={libDraft} setDraft={setLibDraft} base={baseFns}
            hint="Save it with the version controls above; use it in 3 Array & conditioning → Function libraries. Functions can call lookup(), lookup_row() and rows()."
            tools={<LibFileTools draft={libDraft} setDraft={setLibDraft} items={lib.items} refresh={lib.refresh} base={baseFns} />} />
        </main>
      )}
    </section>
  );
}

/** New conditioning set (2 Structure / 3): name, starting rules and a note. */
function NewSetModal({ path, current, fields, onCreate, onClose }: {
  path: string; current: string; fields: number; onCreate: (name: string, from: "current" | "empty", notes: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState<"current" | "empty">(fields ? "current" : "empty");
  const [notes, setNotes] = useState("");
  return (
    <Modal onClose={onClose} label="New conditioning set" size="sm">
      <div className="mh"><h3>New conditioning set</h3></div>
      <div className="mb">
        <label className="f">Name<input type="text" autoFocus aria-label="Conditioning set name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. RTAC point tags" /></label>
        <span className="muted">Array <code>{path}</code></span>
        <fieldset className="f">
          <label className="ctl"><input type="radio" name="from" checked={from === "current"} disabled={!fields} onChange={() => setFrom("current")} /> Rules of 3 Array &amp; conditioning — {current} ({plural(fields, "field")}); the template is recorded with the set</label>
          <label className="ctl"><input type="radio" name="from" checked={from === "empty"} onChange={() => setFrom("empty")} /> Empty (no rules yet)</label>
        </fieldset>
        <label className="f">Note (optional)<textarea aria-label="Conditioning set note" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), from, notes)}>Save v1.001</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 1 Sources

/** Left panel of 1 Sources: every saved source, JSON documents and lookup tables on separate tabs. */
function SavedSources({ items, cur, kind, onPick }: { items: Versioned[]; cur: Pointer; kind: "json" | "table"; onPick: (id: string, v: Ver) => void }) {
  const [tab, setTab] = useLocal<"json" | "table">("fpl.json.srcPanel", kind);
  const [q, setQ] = useState("");
  const kindOf = (it: Versioned) => (latest(it.versions)?.meta as { kind?: string } | undefined)?.kind;
  const json = items.filter((x) => kindOf(x) === "json");
  const tables = items.filter((x) => kindOf(x) === "table");
  const ql = q.trim().toLowerCase();
  const list = (tab === "json" ? json : tables).filter((x) => !ql || x.name.toLowerCase().includes(ql)).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const size = (v: Versioned["versions"][number]) => {
    const m = (v.meta ?? {}) as { rows?: number; cols?: number };
    return tab === "json" ? `${((m.rows ?? 0) / 1024).toFixed(1)} KB` : `${plural(m.rows ?? 0, "row")} × ${plural(m.cols ?? 0, "column")}`;
  };
  return (
    <section className="pane jsv-saved" aria-label="Saved sources">
      <div className="pane-head">
        <h2>Saved</h2>
        <Seg<"json" | "table"> label="Saved source kind" value={tab} onChange={setTab} options={[["json", `JSON (${json.length})`], ["table", `Tables (${tables.length})`]]} />
      </div>
      <div className="toolbar sub"><input type="search" aria-label="Filter saved sources" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} /></div>
      <div className="scroll">
        <ul className="jsv-list">
          {list.map((it) => {
            const lv = latest(it.versions);
            const on = cur.id === it.id;
            const vs = it.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
            return (
              <li key={it.id} className={on ? "on" : undefined}>
                <button type="button" className="item" aria-current={on || undefined} title={`Load ${it.name} v${lv ? verLabel(lv) : "–"} into the editor`} onClick={() => lv && onPick(it.id, lv)}>
                  <span className="nm">{it.name}</span>
                  <span className="meta">{lv ? `v${verLabel(lv)} · ${size(lv)} · ${fmtDateTime(lv.savedAt)}` : "no versions"}</span>
                </button>
                {on && vs.length > 1 && (
                  <div className="vers">
                    {vs.map((v) => (
                      <button key={verLabel(v)} type="button" className={sameVer(v, cur.loaded) ? "on" : undefined} title={v.notes || undefined} onClick={() => onPick(it.id, v)}>v{verLabel(v)}</button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          {!list.length && <li className="muted empty">{ql ? "No match." : tab === "json" ? "No saved JSON documents yet. Paste one on the right and Save." : "No saved lookup tables yet. Switch the editor to Lookup table, paste rows and Save."}</li>}
        </ul>
      </div>
    </section>
  );
}

/** Right panel of 2 Structure: saved conditionings with the array each was made for. */
function CondPanel({ items, cur, nodes, hasDoc, curPath, onPick, onTab, instanceId, instanceName }: {
  items: CondItem[]; cur: Pointer; nodes: JsNode[]; hasDoc: boolean; curPath: string;
  onPick: (id: string, v: Ver) => void; onTab: (t: Tab) => void;
  /** Open instance: its sets are listed by default (the same list as Instances → Conditioning Rules). */
  instanceId: string | null; instanceName: string;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useLocal<"instance" | "library" | "all">("fpl.json.condScope", "instance");
  const sc = instanceId ? scope : scope === "instance" ? "all" : scope;
  const ql = q.trim().toLowerCase();
  const inScope = (x: CondItem) => (sc === "instance" ? x.instanceId === instanceId : sc === "library" ? !x.instanceId : true);
  const list = items.filter(inScope).filter((x) => !ql || x.name.toLowerCase().includes(ql) || String((latest(x.versions)?.meta as { path?: string } | undefined)?.path ?? "").toLowerCase().includes(ql))
    .slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section className="pane jsv-saved" aria-label="Saved conditionings">
      <div className="pane-head">
        <h2>Conditionings</h2>
        <Seg<"instance" | "library" | "all"> label="Conditioning scope" value={sc} onChange={setScope}
          options={[...(instanceId ? [["instance", `This instance (${items.filter((x) => x.instanceId === instanceId).length})`] as ["instance", string]] : []), ["library", `Library (${items.filter((x) => !x.instanceId).length})`], ["all", "All"]]} />
      </div>
      {sc === "instance" && <div className="hint jsv-scopehint">Sets of {instanceName || "this instance"} — the same list as Instances → Conditioning Rules. Select one to load it.</div>}
      <div className="toolbar sub"><input type="search" aria-label="Filter conditionings" placeholder="Filter by name or path…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} /></div>
      <div className="scroll">
        <ul className="jsv-list">
          {list.map((it) => {
            const on = cur.id === it.id;
            const vs = it.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
            const shown = (on && cur.loaded && vs.find((v) => sameVer(v, cur.loaded))) || latest(it.versions);
            const m = (shown?.meta ?? {}) as { fields?: number; lookups?: number; path?: string; source?: string; template?: string };
            const inDoc = !!m.path && nodes.some((n) => n.path === m.path && n.kind === "array");
            return (
              <li key={it.id} className={on ? "on" : undefined}>
                <button type="button" className="item" aria-current={on || undefined} onClick={() => shown && onPick(it.id, latest(it.versions) ?? shown)}
                  title={m.path ? `Load and select the array ${m.path}` : "Load (the array was not recorded with this version)"}>
                  <span className="nm">{it.name}</span>
                  <span className="meta">v{shown ? verLabel(shown) : "–"} · {plural(m.fields ?? 0, "field")}{m.lookups ? ` · ${plural(m.lookups, "lookup")}` : ""}</span>
                  {m.path ? (
                    <span className="meta"><code className={on && curPath === m.path ? "hl" : undefined}>{m.path}</code>{" "}
                      {hasDoc && <span className={`chip ${inDoc ? "info" : "warn"}`}>{inDoc ? "in this document" : "not in this document"}</span>}
                    </span>
                  ) : <span className="meta muted">array not recorded (saved before r22)</span>}
                  {m.source && <span className="meta muted">source: {m.source}</span>}
                  {m.template && <span className="meta muted">from template: {m.template}</span>}
                  {sc !== "instance" && <span className="meta muted">{it.instanceId ? (it.instanceId === instanceId ? "this instance" : "another instance") : "library"}</span>}
                </button>
                {on && (
                  <div className="vers">
                    {vs.map((v) => (
                      <button key={verLabel(v)} type="button" className={sameVer(v, cur.loaded) ? "on" : undefined} title={v.notes || undefined} onClick={() => onPick(it.id, v)}>v{verLabel(v)}</button>
                    ))}
                    <span className="grow" />
                    <button type="button" onClick={() => onTab("array")}>3 Conditioning →</button>
                    <button type="button" className="btn-primary" onClick={() => onTab("output")}>4 Output →</button>
                  </div>
                )}
              </li>
            );
          })}
          {!list.length && <li className="muted empty">{ql ? "No match." : sc === "instance" ? "No conditioning sets in this instance yet. Select an array and + New conditioning set." : "No saved conditionings yet. Condition an array in 3 and Save."}</li>}
        </ul>
      </div>
    </section>
  );
}

function SourcesTab({ src, setSrc, onUse, onNew, items, cur, onPick }: {
  src: JsSource; setSrc: (s: JsSource) => void; onUse: () => void; onNew: () => void;
  items: Versioned[]; cur: Pointer; onPick: (id: string, v: Ver) => void;
}) {
  const ui = useUi();
  const [paste, setPaste] = useState<"json" | "rows" | null>(null);
  const parsed = useMemo(() => (src.kind === "json" && src.text?.trim() ? parseJson(src.text) : null), [src.kind, src.text]);
  const stats = useMemo(() => (parsed?.ok ? scanJson(parsed.value) : []), [parsed]);
  const table: JsTableData = { columns: src.columns ?? [], rows: src.rows ?? [] };
  const issues = src.kind === "table" ? tableIssues(table) : [];
  const ta = useRef<HTMLTextAreaElement>(null);
  const newSource = async (kind: "json" | "table") => {
    const empty = src.kind === "json" ? !src.text?.trim() : !(src.rows ?? []).length;
    if (!empty && !(await ui.confirm("Start a new source? The current one is replaced in the editor (saved versions are kept).", "New source"))) return;
    setSrc(kind === "json" ? { kind, name: "", text: "" } : { kind, name: "", columns: [{ name: "Key", type: "text" }, { name: "Value", type: "text" }], rows: [] });
    onNew();
  };
  const setTable = (t: Partial<JsTableData>) => setSrc({ ...src, columns: t.columns ?? table.columns, rows: t.rows ?? table.rows });
  const goError = () => {
    if (!parsed || parsed.ok || !ta.current) return;
    const m = /line (\d+), column (\d+)/.exec(parsed.error);
    if (!m) return;
    const lines = (src.text ?? "").split("\n");
    const pos = lines.slice(0, +m[1] - 1).reduce((a, l) => a + l.length + 1, 0) + +m[2] - 1;
    ta.current.focus();
    ta.current.setSelectionRange(pos, pos + 1);
  };
  return (
    <main className="jsv-src">
      <SavedSources items={items} cur={cur} kind={src.kind} onPick={onPick} />
      <section className="pane" aria-label="Source">
        <div className="pane-head jsv-head">
          <Seg<"json" | "table"> label="Source kind" value={src.kind} onChange={(k) => k !== src.kind && newSource(k)} options={[["json", "JSON document"], ["table", "Lookup table"]]} />
          <button type="button" title="Start a new, unsaved source of this kind" onClick={() => newSource(src.kind)}>New</button>
          <input type="text" aria-label="Source name" placeholder={src.kind === "json" ? "Name, e.g. RTAC tag export" : "Name, e.g. Device prefixes"} value={src.name} onChange={(e) => setSrc({ ...src, name: e.target.value })} style={{ minWidth: 240, fontWeight: 600 }} />
          {src.kind === "json" ? (
            <>
              <button type="button" className="btn-primary" onClick={() => setPaste("json")}>Paste JSON…</button>
              <label className="btn">Import file…<input type="file" accept=".json,application/json,.txt" onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setSrc({ ...src, text: await f.text(), name: src.name || f.name.replace(/\.[^.]+$/, "") });
                ui.toast(`Loaded ${f.name}`);
              }} /></label>
              <button type="button" disabled={!parsed?.ok} onClick={() => parsed?.ok && setSrc({ ...src, text: JSON.stringify(parsed.value, null, 2) })}>Format</button>
              <span className="grow" />
              <button type="button" disabled={!parsed?.ok} onClick={onUse}>Open in Structure →</button>
            </>
          ) : (
            <>
              <button type="button" className="btn-primary" onClick={() => setPaste("rows")}>Paste rows…</button>
              <button type="button" onClick={() => setTable({ columns: [...table.columns, { name: `Column ${table.columns.length + 1}`, type: "text" }], rows: table.rows.map((r) => [...r, ""]) })}>+ Column</button>
              <button type="button" onClick={() => setTable({ rows: [...table.rows, table.columns.map(() => "")] })}>+ Row</button>
              <span className="grow" />
              <span className={`chip ${issues.length ? "err" : "info"}`}>{issues.length ? plural(issues.length, "issue") : `${plural(table.rows.length, "row")} · valid`}</span>
            </>
          )}
        </div>
        {src.kind === "json" ? (
          <div className="jsv-json">
            <div className="toolbar sub">
              {!src.text?.trim() ? <span className="muted">Paste or import a JSON document.</span>
                : parsed?.ok ? <span className="chip info">Valid JSON · {plural(stats.filter((n) => n.kind === "array").length, "array path")} · {plural(stats.filter((n) => n.kind === "object").length, "object path")} · {(src.text.length / 1024).toFixed(1)} KB</span>
                : <><span className="chip err">{parsed && !parsed.ok ? parsed.error : ""}</span><button type="button" onClick={goError}>Go to error</button></>}
            </div>
            <textarea ref={ta} aria-label="JSON text" className="jsv-text" spellCheck={false} value={src.text ?? ""} onChange={(e) => setSrc({ ...src, text: e.target.value })} placeholder={'{\n  "devices": [ { "name": "PCS-1", "points": [ … ] } ]\n}'} />
          </div>
        ) : (
          <div className="scroll">
            <div className="card">
              <div className="head"><h3>Columns</h3><span className="muted">Name and type of each column. Types follow JSON Schema / ISO 8601: dates as YYYY-MM-DD, times as HH:MM[:SS].</span></div>
              <table className="vt jsv-cols">
                <thead><tr><th>Column</th><th>Type</th><th>Format</th><th /></tr></thead>
                <tbody>
                  {table.columns.map((c, j) => (
                    <tr key={j}>
                      <td><input type="text" aria-label={`Column ${j + 1} name`} value={c.name} onChange={(e) => setTable({ columns: table.columns.map((x, k) => (k === j ? { ...x, name: e.target.value } : x)) })} /></td>
                      <td>
                        <select aria-label={`Column ${j + 1} type`} value={c.type} onChange={(e) => setTable({ columns: table.columns.map((x, k) => (k === j ? { ...x, type: e.target.value as JsColType } : x)) })}>
                          {JS_COL_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </td>
                      <td className="muted">{JS_COL_TYPES.find((x) => x[0] === c.type)?.[2]}</td>
                      <td className="nowrap">
                        <button type="button" className="btn-ghost" aria-label="Move up" onClick={() => setTable({ columns: move(table.columns, j, -1), rows: table.rows.map((r) => move(r, j, -1)) })}>↑</button>
                        <button type="button" className="btn-ghost" aria-label="Move down" onClick={() => setTable({ columns: move(table.columns, j, 1), rows: table.rows.map((r) => move(r, j, 1)) })}>↓</button>
                        <HoldButton label={`Delete column ${c.name}`} onHold={() => setTable({ columns: table.columns.filter((_, k) => k !== j), rows: table.rows.map((r) => r.filter((_, k) => k !== j)) })}>✕</HoldButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="head"><h3>Rows</h3><span className="muted">Edit cells directly; invalid values are highlighted.</span></div>
              <div className="preview">
                <table className="grid editing">
                  <thead><tr><th className="idx">#</th>{table.columns.map((c, j) => <th key={j}>{c.name}<span className="k">{c.type}</span></th>)}<th /></tr></thead>
                  <tbody>
                    {table.rows.slice(0, 500).map((r, i) => (
                      <tr key={i}>
                        <td className="idx">{i + 1}</td>
                        {table.columns.map((c, j) => {
                          const bad = checkCell(c.type, r[j] ?? "");
                          return (
                            <td key={j} className={`ed${bad ? " cellerr" : ""}`} title={bad ?? undefined}>
                              <input aria-label={`Row ${i + 1} ${c.name}`} value={r[j] ?? ""} onChange={(e) => setTable({ rows: table.rows.map((x, k) => (k === i ? Object.assign([...x], { [j]: e.target.value }) : x)) })} />
                            </td>
                          );
                        })}
                        <td><button type="button" className="btn-ghost" aria-label={`Delete row ${i + 1}`} onClick={() => setTable({ rows: table.rows.filter((_, k) => k !== i) })}>✕</button></td>
                      </tr>
                    ))}
                    {!table.rows.length && <tr><td colSpan={table.columns.length + 2} className="muted">No rows yet — Paste rows… from Excel or + Row.</td></tr>}
                  </tbody>
                </table>
              </div>
              {table.rows.length > 500 && <span className="muted">Showing 500 of {table.rows.length} rows.</span>}
              {issues.length > 0 && <div className="issues"><table><tbody>{issues.slice(0, 50).map((x, k) => <tr key={k}><td className="lvl-error">Error</td><td>{x.row >= 0 ? `Row ${x.row + 1}` : "Columns"}</td><td>{x.msg}</td></tr>)}</tbody></table></div>}
            </div>
          </div>
        )}
      </section>
      {paste === "json" && (
        <TextModal title="Paste JSON" label="Paste the JSON document (Ctrl+V)" mono onClose={() => setPaste(null)} onOk={(t) => {
          const p = parseJson(t);
          setSrc({ ...src, text: p.ok ? JSON.stringify(p.value, null, 2) : t });
          if (!p.ok) ui.toast(`Pasted, but: ${p.error}`);
          setPaste(null);
        }} />
      )}
      {paste === "rows" && (
        <TextModal title="Paste rows" label="Cells copied from Excel. The first row is used as column names; types are guessed from the values." mono onClose={() => setPaste(null)} okLabel="Replace table" onOk={(t) => {
          const g = parseDelimited(t);
          if (g.length < 1) return;
          const [head, ...rows] = g;
          setTable({ columns: head.map((h, j) => ({ name: h.trim() || `Column ${j + 1}`, type: guessColType(rows.map((r) => r[j] ?? "")) })), rows });
          setPaste(null);
          ui.toast(`${plural(rows.length, "row")} × ${plural(head.length, "column")}`);
        }} />
      )}
    </main>
  );
}

function TextModal({ title, label, onOk, onClose, mono, okLabel = "OK" }: { title: string; label: string; onOk: (t: string) => void; onClose: () => void; mono?: boolean; okLabel?: string }) {
  const [t, setT] = useState("");
  return (
    <Modal onClose={onClose} label={title}>
      <div className="mh"><h3>{title}</h3></div>
      <div className="mb">
        <label className="f">{label}<textarea autoFocus rows={14} value={t} onChange={(e) => setT(e.target.value)} placeholder="Click here and press Ctrl+V" style={mono ? { fontFamily: "var(--f-mono)", fontSize: 12 } : undefined} /></label>
      </div>
      <div className="mf"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!t.trim()} onClick={() => onOk(t)}>{okLabel}</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 2 Structure

function StructureTab({ sel, setSel, jsonItems, srcName, draftIsJson, parsed, doc, nodes, onUse, flash, conds }: {
  sel: Sel; setSel: (s: Sel) => void; jsonItems: Versioned[]; srcName: string; draftIsJson: boolean;
  parsed: ReturnType<typeof parseJson> | null; doc: unknown; nodes: JsNode[]; onUse: () => void;
  /** Changes when a saved conditioning was picked: highlight and reveal the selected array. */
  flash: number; conds: ReactNode;
}) {
  const [arraysOnly, setArraysOnly] = useLocal<boolean>("fpl.json.arraysOnly", false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const it = jsonItems.find((x) => x.id === sel.sourceId);
  const versions = (it?.versions ?? []).slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
  const hidden = (n: JsNode) => {
    for (let p = n.parent; p; p = nodes.find((x) => x.path === p)?.parent ?? null) if (closed.has(p)) return true;
    return false;
  };
  const ql = q.trim().toLowerCase();
  const shown = nodes.filter((n) => (!arraysOnly || n.kind === "array" || nodes.some((m) => m.kind === "array" && m.path.startsWith(n.path) && m.path !== n.path)) && !hidden(n) && (!ql || n.path.toLowerCase().includes(ql)));
  const focusPath = hover ?? sel.path;
  const sample = useMemo(() => {
    if (doc === undefined || !focusPath) return "";
    const node = nodes.find((n) => n.path === focusPath);
    // First value matched by the pattern path; for an array, its first element.
    let v = firstAt(doc, focusPath);
    if (node?.kind === "array" && Array.isArray(v)) v = v[0];
    // Arrays inside the sample are summarised.
    const summ = (x: unknown): unknown =>
      x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, Array.isArray(y) ? `[${y.length} items]` : summ(y)])) : Array.isArray(x) ? `[${x.length} items]` : x;
    return v === undefined ? "" : JSON.stringify(summ(v), null, 2);
  }, [doc, focusPath, nodes]);
  const selNode = nodes.find((n) => n.path === sel.path);
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!flash) return;
    // Open the ancestors of the selected array and bring it into view.
    setClosed((c) => new Set([...c].filter((p) => !sel.path.startsWith(p))));
    setQ("");
    const t = setTimeout(() => treeRef.current?.querySelector("li.sel")?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);
  const fl = flash ? " flash" : "";
  return (
    <main className="jsv-struct3 jsv-struct">
      <section className="pane" aria-label="Document">
        <div className="pane-head"><h2>Document</h2></div>
        <div className="scroll">
          <div className="card">
            <label className="f">JSON source
              <select aria-label="JSON source" value={sel.sourceId ?? ""} onChange={(e) => setSel({ ...sel, sourceId: e.target.value || null, ver: null })}>
                <option value="draft" disabled={!draftIsJson}>Draft from Sources tab{draftIsJson ? "" : " (empty)"}</option>
                {jsonItems.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            {it && (
              <label className="f">Version
                <select aria-label="Source version" value={sel.ver ? verLabel(sel.ver) : ""} onChange={(e) => setSel({ ...sel, ver: e.target.value ? versions.find((v) => verLabel(v) === e.target.value) ?? null : null })}>
                  <option value="">Latest (v{latest(it.versions) ? verLabel(latest(it.versions)!) : "–"})</option>
                  {versions.map((v) => <option key={verLabel(v)} value={verLabel(v)}>v{verLabel(v)}{v.notes ? ` — ${v.notes.slice(0, 30)}` : ""}</option>)}
                </select>
              </label>
            )}
            <span className="muted">{srcName}</span>
            {parsed && !parsed.ok && <span className="chip err">{parsed.error}</span>}
          </div>
          <div className={"card" + fl} key={`sa${flash}`}>
            <h3>Selected array</h3>
            {selNode ? (
              <>
                <code className="jsv-path">{selNode.path}</code>
                <span className="muted">{plural(selNode.count, "element")}{selNode.instances > 1 ? ` in ${selNode.instances} arrays (${selNode.min}–${selNode.max} each)` : ""} · {Object.entries(selNode.itemKinds).map(([k, n]) => `${n} ${k}`).join(", ")}</span>
                <button type="button" className="btn-primary" onClick={onUse}>Condition this array →</button>
              </>
            ) : sel.path && doc !== undefined ? (
              <><code className="jsv-path">{sel.path}</code><span className="chip warn">Not found in this document — pick another source or array.</span></>
            ) : <span className="muted">Click an array in the structure, or a saved conditioning on the right.</span>}
          </div>
          <div className={"card" + fl} key={`fe${flash}`}>
            <h3>First element</h3>
            <span className="muted">{hover ? "Hovered" : "Selected"} path; nested arrays shown as [N items]</span>
            <pre className="jsv-sample">{sample || "—"}</pre>
          </div>
        </div>
      </section>
      <div />
      <section className="pane" aria-label="Structure">
        <div className="pane-head">
          <h2>Structure</h2>
          <span className="hint">{doc === undefined ? "No document" : `${plural(nodes.filter((n) => n.kind === "array").length, "array path")} · ${plural(nodes.filter((n) => n.kind === "object").length, "object path")} · contents summarised`}</span>
          <input type="search" aria-label="Filter paths" placeholder="Filter paths…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="ctl"><input type="checkbox" checked={arraysOnly} onChange={(e) => setArraysOnly(e.target.checked)} /> Arrays only</label>
          <button type="button" onClick={() => setClosed(new Set())}>Expand all</button>
          <button type="button" onClick={() => setClosed(new Set(nodes.filter((n) => n.depth >= 1).map((n) => n.path)))}>Collapse all</button>
        </div>
        <div className="scroll" ref={treeRef}>
          {doc === undefined ? (
            <div className="empty-state"><h3>No document</h3><p>Paste or import JSON in Sources, or pick a saved JSON source on the left.</p></div>
          ) : (
            <ul className="jsv-tree">
              {shown.map((n) => {
                const kids = nodes.some((m) => m.parent === n.path);
                return (
                  <li key={n.path + (sel.path === n.path ? `#${flash}` : "")} style={{ paddingLeft: 8 + n.depth * 16 }} className={[n.kind, sel.path === n.path && "sel", sel.path === n.path && flash && "flash"].filter(Boolean).join(" ")}
                    onMouseEnter={() => setHover(n.path)} onMouseLeave={() => setHover(null)}>
                    <button type="button" className="btn-ghost caret" aria-label={closed.has(n.path) ? "Expand" : "Collapse"} disabled={!kids}
                      onClick={() => setClosed((s) => { const c = new Set(s); if (c.has(n.path)) c.delete(n.path); else c.add(n.path); return c; })}>{kids ? (closed.has(n.path) ? "▸" : "▾") : ""}</button>
                    <button type="button" className="node" aria-pressed={sel.path === n.path} disabled={n.kind !== "array"} title={n.path}
                      onClick={() => setSel({ ...sel, path: n.path })}>
                      <span className={`kind k-${n.kind}`}>{n.kind === "array" ? "[ ]" : "{ }"}</span>
                      <span className="lbl">{n.label === "[*]" ? "each element" : n.label}</span>
                      <span className="sum">
                        {n.kind === "array"
                          ? `${plural(n.count, "item")}${n.instances > 1 ? ` in ${n.instances} arrays` : ""}${Object.keys(n.itemKinds).length ? ` · ${Object.entries(n.itemKinds).map(([k, c]) => (Object.keys(n.itemKinds).length > 1 ? `${c} ${k}` : k)).join(", ")}` : ""}`
                          : `${plural(n.count, "key")}${n.instances > 1 ? ` · in ${n.instances} places` : ""}`}
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
      {conds}
    </main>
  );
}

// ---------------------------------------------------------------- 3 Array & conditioning

function ArrayTab({ sel, doc, elems, cond, setCond, tables, tableItems, libCodes, libs, libItems, refreshLibs, draftCode, focus, setFocus, goStructure }: {
  libCodes: string[]; libs: ReturnType<typeof mergeLibs>["libs"]; libItems: Versioned[]; refreshLibs: () => unknown; draftCode: string;
  sel: Sel; doc: unknown; elems: ReturnType<typeof arrayElements>; cond: JsCond; setCond: (c: JsCond | ((p: JsCond) => JsCond)) => void;
  tables: Record<string, JsTableData>; tableItems: Versioned[]; focus: number; setFocus: (n: number) => void; goStructure: () => void;
}) {
  const [popup, setPopup] = useState<{ fieldId: string; idx: number } | null>(null);
  const pal = useMemo(() => condPalette(elems), [elems]);
  const keys = pal.element;
  const setField = (f: JsField) => setCond((p) => ({ ...p, fields: p.fields.map((x) => (x.id === f.id ? f : x)) }));
  const addField = (from?: JsKey, expr = false) => {
    const f: JsField = { id: uid(), target: from?.path ?? "new_key", source: from?.path ?? "", out: "auto", rules: expr ? [{ op: "expr", a: from ? "value" : '""' }] : [] };
    setCond((p) => ({ ...p, fields: [...p.fields, f] }));
    if (expr) setPopup({ fieldId: f.id, idx: 0 });
  };
  /** Live feedback shows the content after (default) or before the conditioning. */
  const [fbView, setFbView] = useLocal<"after" | "before">("fpl.json.fbView", "after");
  // Live feedback: focused element and the first 50 elements (dry run).
  const preview = useMemo(() => {
    if (doc === undefined || !sel.path) return null;
    const only = [focus, ...Array.from({ length: Math.min(50, elems.length) }, (_, i) => i)];
    return runCond(doc, sel.path, cond, tables, { only: [...new Set(only)], dry: true, libs: libCodes });
  }, [doc, sel.path, cond, tables, focus, elems.length, libCodes]);
  const focusRes = preview?.elems.find((r) => r.ptr === elems[focus]?.ptr);
  const after = useMemo(() => {
    if (!focusRes || !elems[focus]) return null;
    const v = structuredClone(elems[focus].value) as Record<string, unknown>;
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [t, f] of Object.entries(focusRes.fields)) setDeep(v, t, f.after);
    return v;
  }, [focusRes, elems, focus]);
  const labelOf = (i: number) => {
    const e = elems[i];
    if (!e) return "";
    const v = e.value as Record<string, unknown>;
    const k = v && typeof v === "object" ? Object.entries(v).find(([, x]) => typeof x === "string")?.[1] : v;
    return `${e.ptr}${k !== undefined ? ` · ${shortJson(k, 28)}` : ""}`;
  };
  const field = popup ? cond.fields.find((f) => f.id === popup.fieldId) : undefined;

  if (!sel.path || doc === undefined)
    return <main className="plb-one"><section className="pane"><div className="empty-state"><h3>No array selected</h3><p>Pick a document and an array in Structure.</p><button type="button" className="btn-primary" onClick={goStructure}>Go to Structure</button></div></section></main>;
  return (
    <main className="jsv-array">
      <section className="pane" aria-label="Element keys">
        <div className="pane-head"><h2>Element keys</h2><span className="hint">{plural(elems.length, "element")} · <code>{sel.path}</code></span></div>
        <div className="scroll">
          <table className="vt jsv-keys">
            <thead><tr><th>Key</th><th title="Elements that have the key">In</th><th>Samples</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.path} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", pyPath("el", k.path))}>
                  <td className="mono">{k.path || "(value)"}</td>
                  <td className="mono" title={Object.entries(k.kinds).map(([a, b]) => `${b} ${a}`).join(", ")}>{k.count === elems.length ? "all" : `${k.count}/${elems.length}`}</td>
                  <td className="muted samples">{k.samples.join(" · ")}</td>
                  <td className="nowrap"><button type="button" className="btn-ghost" title="Condition this key (rules)" onClick={() => addField(k)}>+</button><button type="button" className="btn-ghost" title="Condition this key with an expression" onClick={() => addField(k, true)}>ƒ</button></td>
                </tr>
              ))}
              {pal.parent.length > 0 && <tr><th colSpan={4}>Parent object keys (parent.…)</th></tr>}
              {pal.parent.map((k) => (
                <tr key={"p:" + k.path} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", pyPath("parent", k.path))}>
                  <td className="mono">parent.{k.path}</td><td className="mono">{k.count}</td><td className="muted samples">{k.samples.join(" · ")}</td><td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="pane" aria-label="Conditioning">
        <div className="pane-head">
          <h2>Conditioning</h2>
          <span className="hint">Each field writes a key of every element. Starts from a key (or empty), runs its rules left to right.</span>
          <button type="button" className="btn-primary" onClick={() => addField(undefined, true)}>+ Field (expression)</button>
          <button type="button" onClick={() => addField()}>+ Field (rules)</button>
        </div>
        <div className="scroll">
          <datalist id="jsv-keys">{keys.map((k) => <option key={k.path} value={k.path} />)}</datalist>
          <datalist id="jsv-srckeys">{[...keys.map((k) => k.path), ...pal.parent.map((k) => `parent.${k.path}`)].map((k) => <option key={k} value={k} />)}</datalist>
          <table className="vt plb-cols jsv-fields">
            <thead><tr><th>Target key</th><th>Starts from</th><th>Write as</th><th>Rules</th><th>Focused result</th><th /></tr></thead>
            <tbody>
              {cond.fields.map((f, i) => {
                const fr = focusRes?.fields[f.target];
                return (
                  <tr key={f.id} className={f.off ? "off" : undefined}>
                    <td><input type="checkbox" aria-label="Enabled" checked={!f.off} onChange={(e) => setField({ ...f, off: !e.target.checked })} /> <input type="text" list="jsv-keys" aria-label="Target key" value={f.target} onChange={(e) => setField({ ...f, target: e.target.value })} style={{ width: 130 }} /></td>
                    <td><input type="text" list="jsv-srckeys" aria-label="Starts from" placeholder="— empty —" value={f.source} onChange={(e) => setField({ ...f, source: e.target.value })} style={{ width: 130 }} /></td>
                    <td><select aria-label="Write as" value={f.out} onChange={(e) => setField({ ...f, out: e.target.value as JsOutType })}>{JS_OUT_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                    <td><RuleChain rules={f.rules} onChange={(rules: PlRule[]) => setField({ ...f, rules })} openExpr={(idx) => setPopup({ fieldId: f.id, idx })} /></td>
                    <td className={`mono sample${fr?.warn.length ? " warn" : ""}`} title={fr?.warn.join("\n")}>{fr ? `${shortJson(fr.before, 18)} → ${shortJson(fr.after, 30)}` : ""}{fr?.warn.length ? ` ⚠${fr.warn.length}` : ""}</td>
                    <td className="nowrap">
                      <button type="button" className="btn-ghost" aria-label="Move up" onClick={() => setCond((p) => ({ ...p, fields: move(p.fields, i, -1) }))}>↑</button>
                      <button type="button" className="btn-ghost" aria-label="Move down" onClick={() => setCond((p) => ({ ...p, fields: move(p.fields, i, 1) }))}>↓</button>
                      <HoldButton label={`Delete field ${f.target}`} onHold={() => setCond((p) => ({ ...p, fields: p.fields.filter((x) => x.id !== f.id) }))}>✕</HoldButton>
                    </td>
                  </tr>
                );
              })}
              {!cond.fields.length && <tr><td colSpan={6} className="muted">No fields yet. + Field (expression), or + / ƒ next to a key on the left.</td></tr>}
            </tbody>
          </table>

          <div className="card">
            <div className="head"><h3>Function libraries</h3><span className="muted">Custom Python functions (5 Functions) callable from expressions and code, e.g. first_number(value, "_").</span></div>
            <LibPicker refs={cond.libs ?? []} onChange={(r) => setCond((p) => ({ ...p, libs: r }))} items={libItems} allowDraft />
            {libs.some((l) => l.error) && <span className="chip err">{libs.find((l) => l.error)!.error}</span>}
            {libs.length > 0 && <span className="muted">{libs.flatMap((l) => l.funcs).map((f) => f.sig).join(" · ") || "No functions"}</span>}
          </div>
          <div className="card">
            <div className="head"><h3>Lookup tables</h3><span className="muted">Saved lookup tables (Sources) used by lookup("name", …), lookup_row(…) and rows(…).</span>
              <button type="button" disabled={!tableItems.length} onClick={() => setCond((p) => ({ ...p, lookups: [...p.lookups, { alias: tableItems[0]?.name ?? "Table", sourceId: tableItems[0]?.id ?? null, ver: null }] }))}>+ Lookup table</button>
            </div>
            {cond.lookups.map((l, i) => {
              const t = tables[l.alias.trim()];
              return (
                <div className="toolbar sub" key={i}>
                  <label className="ctl">Name <input type="text" aria-label="Lookup name" value={l.alias} onChange={(e) => setCond((p) => ({ ...p, lookups: p.lookups.map((x, k) => (k === i ? { ...x, alias: e.target.value } : x)) }))} style={{ width: 140 }} /></label>
                  <select aria-label="Lookup table source" value={l.sourceId ?? ""} onChange={(e) => setCond((p) => ({ ...p, lookups: p.lookups.map((x, k) => (k === i ? { ...x, sourceId: e.target.value || null, ver: null } : x)) }))}>
                    <option value="">— table —</option>
                    {tableItems.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <span className="muted">{t ? `${plural(t.rows.length, "row")} · ${t.columns.map((c) => `${c.name} (${c.type})`).join(", ")}` : "not loaded"}</span>
                  <HoldButton label={`Remove lookup ${l.alias}`} onHold={() => setCond((p) => ({ ...p, lookups: p.lookups.filter((_, k) => k !== i) }))}>✕</HoldButton>
                </div>
              );
            })}
            {!tableItems.length && <span className="muted">No saved lookup tables yet — create one in Sources (Lookup table) and save it.</span>}
          </div>
        </div>
      </section>
      <section className="pane" aria-label="Live feedback">
        <div className="pane-head">
          <h2>Live feedback</h2>
          <span className="hint">{preview ? `${preview.elems.filter((r) => r.changed).length} of ${preview.elems.length} previewed elements change · ${plural(preview.warnings, "warning")}` : ""}</span>
        </div>
        <div className="toolbar sub">
          <button type="button" aria-label="Previous element" disabled={focus <= 0} onClick={() => setFocus(focus - 1)}>‹</button>
          <select aria-label="Focus element" value={focus} onChange={(e) => setFocus(+e.target.value)} style={{ maxWidth: 300 }}>
            {elems.slice(0, 2000).map((_, i) => <option key={i} value={i}>{labelOf(i)}</option>)}
          </select>
          <button type="button" aria-label="Next element" disabled={focus >= elems.length - 1} onClick={() => setFocus(focus + 1)}>›</button>
          <span className="muted">{focus + 1} / {elems.length}</span>
          <span className="grow" />
          <Seg<"after" | "before"> label="Show content" value={fbView} onChange={setFbView} options={[["after", "After"], ["before", "Before"]]} />
        </div>
        <div className="scroll">
          <div className={`jsv-one ${fbView}`}>
            <h4>{fbView === "after" ? "After conditioning" : "Before conditioning (original)"}</h4>
            <pre aria-label={fbView === "after" ? "Content after" : "Content before"}>{fbView === "before" || !after ? JSON.stringify(elems[focus]?.value, null, 2) : JSON.stringify(after, null, 2)}</pre>
          </div>
          {focusRes && Object.values(focusRes.fields).some((f) => f.warn.length) && (
            <div className="issues">{Object.entries(focusRes.fields).flatMap(([k, f]) => f.warn.map((w, j) => <div key={k + j} className="lvl-warn">{k}: {w}</div>))}</div>
          )}
          <h4>First {Math.min(50, elems.length)} elements</h4>
          <table className="vt jsv-prev">
            <thead><tr><th>Element</th>{cond.fields.filter((f) => !f.off).map((f) => <th key={f.id}>{f.target}{fbView === "before" ? " (before)" : ""}</th>)}</tr></thead>
            <tbody>
              {preview?.elems.filter((r) => r.ptr !== elems[focus]?.ptr || true).slice(0, 51).map((r) => (
                <tr key={r.ptr} className={r.ptr === elems[focus]?.ptr ? "sel" : undefined} onClick={() => setFocus(elems.findIndex((e) => e.ptr === r.ptr))}>
                  <td className="mono">{r.ptr.replace(sel.path.replace(/\[\*\]/g, "").replace(/\.[^.[]+$/, ""), "…")}</td>
                  {cond.fields.filter((f) => !f.off).map((f) => {
                    const x = r.fields[f.target];
                    return <td key={f.id} className={`mono${x?.warn.length ? " cellwarn" : ""}`} title={x ? `${shortJson(x.before, 60)} → ${shortJson(x.after, 60)}${x.warn.length ? "\n" + x.warn.join("\n") : ""}` : undefined}>{x ? shortJson(fbView === "before" ? x.before : x.after, 40) : ""}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {popup && field && field.rules[popup.idx] && (
        <JsonExprPopup field={field} idx={popup.idx} elems={elems} doc={doc} path={sel.path} cond={cond} setCond={setCond} tables={tables} libCodes={libCodes} libs={libs} libItems={libItems} refreshLibs={refreshLibs} draftCode={draftCode} pal={pal} focus={focus} setFocus={setFocus} labelOf={labelOf}
          onApply={(target, rule) => {
            setField({ ...field, target, rules: field.rules.map((r, k) => (k === popup.idx ? rule : r)) });
            setPopup(null);
          }}
          onClose={() => setPopup(null)} />
      )}
    </main>
  );
}
function firstAt(doc: unknown, path: string): unknown {
  let cur: unknown[] = [doc];
  for (const seg of parsePath(path)) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (seg.k === "all" && Array.isArray(c)) next.push(...c);
      else if (seg.k === "idx" && Array.isArray(c)) next.push(c[seg.v]);
      else if (seg.k === "key" && c && typeof c === "object" && !Array.isArray(c) && seg.v in c) next.push((c as Record<string, unknown>)[seg.v]);
      if (next.length) break;
    }
    cur = next;
    if (!cur.length) return undefined;
  }
  return cur[0];
}
function setDeep(o: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split(".");
  let cur = o;
  ks.forEach((k, i) => {
    if (i === ks.length - 1) cur[k] = v;
    else {
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
  });
}

/** Expression / Python code popup with every referable key, lookup tables and live results. */
function JsonExprPopup({ field, idx, elems, doc, path, cond, setCond, tables, libCodes, libs, libItems, refreshLibs, draftCode, pal, focus, setFocus, labelOf, onApply, onClose }: {
  libCodes: string[]; libs: ReturnType<typeof mergeLibs>["libs"]; libItems: Versioned[]; refreshLibs: () => unknown; draftCode: string;
  setCond: (f: (p: JsCond) => JsCond) => void;
  field: JsField; idx: number; elems: ReturnType<typeof arrayElements>; doc: unknown; path: string; cond: JsCond; tables: Record<string, JsTableData>;
  pal: ReturnType<typeof condPalette>; focus: number; setFocus: (n: number) => void; labelOf: (i: number) => string;
  onApply: (target: string, rule: PlRule) => void; onClose: () => void;
}) {
  const rule = field.rules[idx];
  const [mode, setMode] = useState<"expr" | "code">(rule.op === "code" ? "code" : "expr");
  const [src, setSrc] = useState(rule.op === "expr" || rule.op === "code" ? rule.a ?? "" : "");
  const [target, setTarget] = useState(field.target);
  const [tab, setTab] = useState<"el" | "py" | "lookup" | "fn">("el");
  const fnBase = useMemo(() => lookupFns(tables), [tables]);
  const ta = useRef<HTMLTextAreaElement>(null);
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
  const used = mode === "code" ? codeNames(src) : exprNames(src);
  const res = useMemo(() => {
    if (err || !src.trim()) return null;
    const log: string[] = [];
    const tmp: JsCond = { ...cond, fields: cond.fields.map((f) => (f.id === field.id ? { ...f, target, rules: f.rules.map((r, k) => (k === idx ? { op: mode, a: src } : r)) } : f)) };
    const only = [...new Set([focus, ...Array.from({ length: Math.min(12, elems.length) }, (_, i) => i)])];
    const r = runCond(doc, path, tmp, tables, { only, dry: true, libs: libCodes, log: (ptr, s) => ptr === elems[focus]?.ptr && log.push(s) });
    return { r, log };
  }, [err, src, mode, cond, field.id, target, idx, focus, elems, doc, path, tables, libCodes]);
  const fr = res?.r.elems.find((x) => x.ptr === elems[focus]?.ptr)?.fields[target];
  const Chip = ({ code, help, onPick }: { code: string; help: string; onPick?: () => void }) => (
    <button type="button" draggable className="snip" title={help} onDragStart={(e) => (e.dataTransfer.setData("text/plain", code), onPick?.())} onClick={() => (onPick?.(), insert(code))}>
      <code>{code}</code><span>{help}</span>
    </button>
  );
  const q = (x: string) => JSON.stringify(x);
  return (
    <Modal onClose={onClose} label="Expression">
      <div className="exprmodal">
        <div className="mh">
          <h3>Condition</h3>
          <label className="ctl">Target key <input type="text" aria-label="Popup target key" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 160 }} /></label>
          <Seg<"expr" | "code"> label="Mode" value={mode} onChange={setMode} options={[["expr", "Expression"], ["code", "Python code"]]} />
          <span className="muted">starts from {field.source ? <code>{field.source}</code> : "empty"} · rule {idx + 1}</span>
        </div>
        <div className="mb">
          <div className="exprgrid">
            <section>
              <label className="f">{mode === "code" ? "Python code — return the new value" : "Python expression"} — drag keys from the right or click to insert
                <textarea ref={ta} rows={mode === "code" ? 12 : 5} aria-label="Expression" className="exprsrc" spellCheck={false} value={src} onChange={(e) => setSrc(e.target.value)}
                  placeholder={mode === "code" ? 'name = el["name"]\nrow = lookup_row("Tags", "Device", parent["name"])\nif row is None:\n    return name\nreturn f"{row[\'Prefix\']}_{name}"' : 'f"{parent[\'name\']}_{el[\'tag\']}"'} />
              </label>
              <div className="toolbar sub">
                {err ? <span className="chip err">Syntax: {err}</span> : src.trim() ? <span className="chip info">Syntax OK</span> : <span className="muted">Empty</span>}
                <span className="muted">uses {[...used].filter((x) => ["el", "parent", "root", "value", "index", "lookup", "lookup_row", "rows", "col", "out"].includes(x)).join(", ") || "—"}</span>
              </div>
              <div className="toolbar sub">
                <span className="ctl">Focus</span>
                <button type="button" aria-label="Previous element" disabled={focus <= 0} onClick={() => setFocus(focus - 1)}>‹</button>
                <select aria-label="Popup focus element" value={focus} onChange={(e) => setFocus(+e.target.value)} style={{ maxWidth: 320 }}>
                  {elems.slice(0, 2000).map((_, i) => <option key={i} value={i}>{labelOf(i)}</option>)}
                </select>
                <button type="button" aria-label="Next element" disabled={focus >= elems.length - 1} onClick={() => setFocus(focus + 1)}>›</button>
              </div>
              <div className="jsv-focus">
                <div><span className="muted">Before</span><code>{fr ? shortJson(fr.before, 80) : "—"}</code></div>
                <div><span className="muted">New content</span><code className="new">{fr ? shortJson(fr.after, 120) : "—"}</code></div>
                {fr?.warn.map((w, k) => <div key={k} className="chip err">{w}</div>)}
                {res?.log.length ? <pre className="jsv-log">{res.log.join("\n")}</pre> : null}
              </div>
              <table className="vt exprprev">
                <thead><tr><th>Element</th><th>Before</th><th>New content</th></tr></thead>
                <tbody>
                  {res?.r.elems.slice(0, 13).map((x) => {
                    const f = x.fields[target];
                    return (
                      <tr key={x.ptr} className={[x.ptr === elems[focus]?.ptr && "sel", f?.warn.length && "bad"].filter(Boolean).join(" ") || undefined} onClick={() => setFocus(elems.findIndex((e) => e.ptr === x.ptr))}>
                        <td className="mono">{x.ptr}</td><td className="mono">{f ? shortJson(f.before, 30) : ""}</td><td className="mono">{f ? shortJson(f.after, 50) : ""}{f?.warn.length ? <div className="chip err">{f.warn[0]}</div> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            <section className="exprpal">
              <Seg<"el" | "py" | "lookup" | "fn"> label="Referable items" value={tab} onChange={setTab} options={[["el", "Element & parents"], ["py", "Python syntax"], ["lookup", "Lookup tables"], ["fn", `Functions${libs.length ? ` (${libs.flatMap((l) => l.funcs).length})` : ""}`]]} />
              <div className="snips">
                {tab === "el" && (
                  <>
                    <div><h4>This element (el)</h4>{pal.element.map((k: JsKey) => <Chip key={k.path} code={pyPath("el", k.path)} help={`${k.samples.join(" · ")}${k.count < elems.length ? ` · in ${k.count}/${elems.length}` : ""}`} />)}</div>
                    {pal.parent.length > 0 && <div><h4>Parent object (parent)</h4>{pal.parent.map((k: JsKey) => <Chip key={k.path} code={pyPath("parent", k.path)} help={k.samples.join(" · ")} />)}</div>}
                    <div><h4>Context</h4>{([["value", "Value this field starts from (text)"], ["index", "Position in its array (0-based)"], ["path", "Path of the element, e.g. $.devices[3].points[7]"], ["el.get(\"key\", \"\")", "Key with a default when missing"], ['root["key"]', "Top-level key of the document"], ["to_json(el)", "Element as JSON text"]] as Snip[]).map(([c, h]) => <Chip key={c} code={c} help={h} />)}</div>
                  </>
                )}
                {tab === "py" && PY_SNIPPETS.map(([g, l]) => <div key={g}><h4>{g}</h4>{l.map(([c, h]) => <Chip key={c} code={c} help={h} />)}</div>)}
                {tab === "fn" && <FunctionsPalette refs={cond.libs ?? []} onRefs={(r) => setCond((p) => ({ ...p, libs: r }))} items={libItems} libs={libs} Chip={Chip} draftCode={draftCode} allowDraft base={fnBase} onRefresh={refreshLibs} where="this conditioning" />}
                {tab === "lookup" && (
                  <>
                    {Object.entries(tables).map(([name, t]) => (
                      <div key={name}>
                        <h4>{name} · {plural(t.rows.length, "row")}</h4>
                        <Chip code={`lookup(${q(name)}, ${q(t.columns[0]?.name ?? "Key")}, value, ${q(t.columns[1]?.name ?? "Value")}, default="")`} help="VLOOKUP: value of a column in the first matching row (case-insensitive exact match)" />
                        <Chip code={`lookup_row(${q(name)}, ${q(t.columns[0]?.name ?? "Key")}, value)`} help="Left join: the whole matching row as a dict, or None" />
                        <Chip code={`rows(${q(name)})`} help="Every row as a dict (for loops / comprehensions)" />
                        {t.columns.map((c) => <Chip key={c.name} code={q(c.name)} help={`Column ${c.name} (${c.type})`} />)}
                      </div>
                    ))}
                    {!Object.keys(tables).length && <span className="muted">No lookup tables loaded — add one under Lookup tables in this tab.</span>}
                  </>
                )}
              </div>
            </section>
          </div>
        </div>
        <div className="mf"><span className="info">Values from keys are Python values (text, numbers, lists, dicts); the result is written with “Write as”.</span><button type="button" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!!err || !target.trim()} onClick={() => onApply(target.trim(), { ...rule, op: mode, a: src })}>Apply</button></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 4 Output

function OutputTab({ sel, doc, cond, tables, libCodes, srcName, condName, onSaved }: { sel: Sel; doc: unknown; cond: JsCond; tables: Record<string, JsTableData>; libCodes: string[]; srcName: string; condName: string; onSaved: () => void }) {
  const ui = useUi();
  const [show, setShow] = useState<"changes" | "json">("changes");
  const res = useMemo(() => (doc !== undefined && sel.path ? runCond(doc, sel.path, cond, tables, { libs: libCodes }) : null), [doc, sel.path, cond, tables, libCodes]);
  const text = useMemo(() => (res ? JSON.stringify(res.out, null, 2) : ""), [res]);
  const changes = res ? res.elems.flatMap((e) => Object.entries(e.fields).filter(([, f]) => JSON.stringify(f.before) !== JSON.stringify(f.after) || f.warn.length).map(([k, f]) => ({ ptr: e.ptr, k, f }))) : [];
  if (!res) return <main className="plb-one"><section className="pane"><div className="empty-state"><h3>Nothing to output</h3><p>Select a document and an array, and add conditioning fields.</p></div></section></main>;
  const saveAsSource = async () => {
    const name = await ui.prompt("Save the result as a JSON source named", `${srcName.replace(/^draft “?|”$/g, "")} (conditioned)`, "Save");
    if (!name) return;
    const s = await api.jsonSources.create({ name });
    await api.jsonSources.saveVersion(s.id, 1, 1, { stamp: new Date().toISOString(), data: { kind: "json", name, text }, meta: { kind: "json", rows: text.length, cols: 1 } });
    ui.toast(`Saved as source “${name}” v1.001`);
    onSaved();
  };
  return (
    <main className="plb-one">
      <section className="pane" aria-label="Output">
        <div className="pane-head">
          <h2>Output</h2>
          <span className="chip info" title="Conditioning · array · document">{condName} · <code>{sel.path}</code> · {srcName}</span>
          <span className="hint">{plural(res.changed, "element")} of {res.elems.length} changed · {plural(res.warnings, "warning")} · {(text.length / 1024).toFixed(1)} KB</span>
          <Seg<"changes" | "json"> label="Show" value={show} onChange={setShow} options={[["changes", `Changes (${changes.length})`], ["json", "Full JSON"]]} />
          <button type="button" onClick={async () => ui.toast((await navigator.clipboard.writeText(text).then(() => true, () => false)) ? "JSON copied" : "Copy blocked")}>Copy JSON</button>
          <button type="button" className="btn-primary" onClick={() => download(`${(srcName.replace(/^draft “?|”$/g, "") || "output").replace(/[^\w.-]+/g, "_")}.json`, text, "application/json")}>Download JSON</button>
          <button type="button" onClick={saveAsSource}>Save as new source…</button>
        </div>
        <div className="scroll">
          {show === "json" ? (
            <pre className="jsv-out">{text.length > 400_000 ? text.slice(0, 400_000) + "\n… (truncated in the preview; Download / Copy give the full file)" : text}</pre>
          ) : (
            <table className="vt jsv-changes">
              <thead><tr><th>Element</th><th>Key</th><th>Before</th><th>After</th><th>Warnings</th></tr></thead>
              <tbody>
                {changes.slice(0, 2000).map((c, i) => (
                  <tr key={i} className={c.f.warn.length ? "bad" : undefined}><td className="mono">{c.ptr}</td><td className="mono">{c.k}</td><td className="mono">{shortJson(c.f.before, 60)}</td><td className="mono">{shortJson(c.f.after, 60)}</td><td>{c.f.warn.join(" · ")}</td></tr>
                ))}
                {!changes.length && <tr><td colSpan={5} className="muted">No changes.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
