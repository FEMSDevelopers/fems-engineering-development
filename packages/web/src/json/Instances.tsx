import {
  emptyCond, emptyInstance, fmtDateTime, PL_RULES, instanceMeta, latest, legacyOutputs, parseJson, runCond, shortJson, stamp, verLabel,
  type JsCond, type JsInstance, type JsSource, type JsTableData, type Ver,
} from "@fpl/core";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api, ApiError, type AppFolder, type CondItem, type InstanceItem, type Versioned } from "../api";
import { useLibCodes } from "../pylibs";
import { HoldButton, Modal, Seg, useLocal, useUi } from "../ui";
import { useVersionData } from "./hooks";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const UNFILED = "unfiled";
export const ALL = "all";
const DND_FOLDER = "application/x-fpl-folder";
const DND_INST = "application/x-fpl-instance";
const RULE_LABEL = new Map(PL_RULES.map((r) => [r.op, r.label]));
/** "Expression ƒ el["name"]… › Pad" */
const ruleText = (rules: JsCond["fields"][number]["rules"]) =>
  rules.map((r) => (r.op === "expr" || r.op === "code" ? `ƒ ${(r.a ?? "").replace(/\s+/g, " ").slice(0, 40)}${(r.a ?? "").length > 40 ? "…" : ""}` : RULE_LABEL.get(r.op) ?? r.op)).join(" › ") || "copy";

/** Folder helpers over the flat list. */
export function folderTree(folders: AppFolder[]) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const kids = new Map<string | null, AppFolder[]>();
  for (const f of folders) {
    const p = f.parentId && byId.has(f.parentId) ? f.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), f]);
  }
  for (const l of kids.values()) l.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const subtree = (id: string): string[] => [id, ...(kids.get(id) ?? []).flatMap((k) => subtree(k.id))];
  const trail = (id: string | null): AppFolder[] => {
    const out: AppFolder[] = [];
    for (let f = id ? byId.get(id) : undefined; f; f = f.parentId ? byId.get(f.parentId) : undefined) out.unshift(f);
    return out;
  };
  const crumb = (id: string | null) => (id && byId.has(id) ? trail(id).map((f) => f.name).join(" / ") : "Unfiled");
  const dept = (id: string | null) => trail(id)[0];
  return { byId, kids, subtree, trail, crumb, dept };
}

// ---------------------------------------------------------------- new instance dialog

export function NewInstanceModal({ folders, folderId, canCopy, title, onCreate, onClose }: {
  folders: AppFolder[]; folderId: string | null; canCopy: boolean; title?: string;
  onCreate: (name: string, folderId: string | null, copy: boolean) => Promise<void> | void; onClose: () => void;
}) {
  const t = folderTree(folders);
  const [name, setName] = useState("");
  const [fid, setFid] = useState<string | null>(folderId ?? t.kids.get(null)?.[0]?.id ?? null);
  const [copy, setCopy] = useState(canCopy && !!title);
  const opts: { id: string; label: string }[] = [];
  const walk = (p: string | null, d: number) => (t.kids.get(p) ?? []).forEach((f) => (opts.push({ id: f.id, label: `${"   ".repeat(d)}${f.name}` }), walk(f.id, d + 1)));
  walk(null, 0);
  return (
    <Modal onClose={onClose} label="New instance" size="sm">
      <div className="mh"><h3>{title ?? "New instance"}</h3></div>
      <div className="mb">
        <label className="f">Name<input type="text" autoFocus aria-label="Instance name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Site A — RTAC tags" /></label>
        <label className="f">Department / folder
          <select aria-label="Instance folder" value={fid ?? ""} onChange={(e) => setFid(e.target.value || null)}>
            {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            <option value="">Unfiled</option>
          </select>
        </label>
        {canCopy && !title && (
          <fieldset className="f">
            <label className="ctl"><input type="radio" name="start" checked={!copy} onChange={() => setCopy(false)} /> Empty (paste a document in 1 Sources)</label>
            <label className="ctl"><input type="radio" name="start" checked={copy} onChange={() => setCopy(true)} /> Copy of the document open in the editor</label>
          </fieldset>
        )}
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), fid, copy)}>Create</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- folder options dialog

function FolderModal({ folder, folders, onClose, onSaved }: { folder: AppFolder; folders: AppFolder[]; onClose: () => void; onSaved: () => void }) {
  const ui = useUi();
  const t = folderTree(folders);
  const [name, setName] = useState(folder.name);
  const [color, setColor] = useState(folder.options.color ?? "#5b6872");
  const [code, setCode] = useState(folder.options.code ?? "");
  const [desc, setDesc] = useState(folder.options.description ?? "");
  const [parent, setParent] = useState<string | null>(folder.parentId);
  const banned = new Set(t.subtree(folder.id));
  const opts: { id: string; label: string }[] = [];
  const walk = (p: string | null, d: number) => (t.kids.get(p) ?? []).forEach((f) => (!banned.has(f.id) && (opts.push({ id: f.id, label: `${"   ".repeat(d)}${f.name}` }), walk(f.id, d + 1))));
  walk(null, 0);
  const isDept = !parent;
  return (
    <Modal onClose={onClose} label="Folder options" size="sm">
      <div className="mh"><h3>{folder.parentId ? "Folder" : "Department"} options</h3></div>
      <div className="mb">
        <label className="f">Name<input type="text" aria-label="Folder name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="f">Location
          <select aria-label="Parent folder" value={parent ?? ""} onChange={(e) => setParent(e.target.value || null)}>
            <option value="">— Top level (department) —</option>
            {opts.map((o) => <option key={o.id} value={o.id}>in {o.label}</option>)}
          </select>
        </label>
        {isDept && <label className="f">Colour<input type="color" aria-label="Department colour" value={color} onChange={(e) => setColor(e.target.value)} /></label>}
        <label className="f">Short code<input type="text" aria-label="Short code" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} placeholder="e.g. ENG" /></label>
        <label className="f">Description<textarea aria-label="Description" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!name.trim()} onClick={async () => {
          try {
            await api.folders.update(folder.id, { name: name.trim(), parentId: parent, options: { ...folder.options, ...(isDept ? { color } : {}), code: code.trim(), description: desc } });
            onSaved();
            onClose();
          } catch (e) {
            ui.toast((e as Error).message);
          }
        }}>Save</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 0 Instances

export interface OpenState {
  id: string | null;
  /** Conditioning set loaded in the editor. */
  cond: string | null;
  dirty: boolean;
}
/** Saved conditioning set (data of a json-conds version). */
type CondSaved = JsCond & { array?: { path: string; sourceId: string | null; ver: Ver | null; sourceName?: string } };

export function InstancesTab({ folders, instances, refresh, open, editorData, srcItems, libItems, draftCode, conds, refreshConds, onOpen }: {
  folders: AppFolder[]; instances: InstanceItem[]; refresh: () => void; open: OpenState; editorData: JsInstance | null;
  srcItems: Versioned[]; libItems: Versioned[]; draftCode: string;
  /** Saved conditioning sets (those with instanceId = an instance belong to it). */
  conds: CondItem[]; refreshConds: () => void;
  onOpen: (id: string, ver: Ver, condId?: string, tab?: "array" | "output" | "sources" | "structure") => void;
}) {
  const ui = useUi();
  const t = useMemo(() => folderTree(folders), [folders]);
  const [node, setNode] = useLocal<string>("fpl.json.inst.node", ALL);
  const [closed, setClosed] = useLocal<string[]>("fpl.json.inst.closed", []);
  const [sub, setSub] = useLocal<boolean>("fpl.json.inst.sub", true);
  const [selId, setSelId] = useLocal<string>("fpl.json.inst.sel", "");
  const [selVer, setSelVer] = useState<string>("");
  const [outId, setOutId] = useLocal<string>("fpl.json.inst.cond", "");
  const [q, setQ] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [optsFor, setOptsFor] = useState<AppFolder | null>(null);
  const [delFor, setDelFor] = useState<{ f: AppFolder; n: number } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const selFolder = t.byId.get(node) ?? null;

  // ---- tree
  const countIn = (id: string) => t.subtree(id).reduce((a, f) => a + (t.byId.get(f)?.instances ?? 0), 0);
  const unfiled = instances.filter((i) => !i.folderId || !t.byId.has(i.folderId));
  const move = async (kind: "folder" | "inst", id: string, to: string | null) => {
    try {
      if (kind === "inst") await api.jsonInstances.move(id, to);
      else await api.folders.update(id, { parentId: to });
      refresh();
    } catch (e) {
      ui.toast((e as Error).message);
    }
  };
  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].some((x) => x === DND_FOLDER || x === DND_INST)) return;
      e.preventDefault();
      setDropOn(target);
    },
    onDragLeave: () => setDropOn((d) => (d === target ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropOn(null);
      const to = target === ALL || target === UNFILED ? null : target;
      const f = e.dataTransfer.getData(DND_FOLDER);
      const i = e.dataTransfer.getData(DND_INST);
      if (i) void move("inst", i, to);
      else if (f && f !== to && target !== UNFILED) void move("folder", f, to);
    },
  });
  const addFolder = async (parentId: string | null) => {
    const name = await ui.prompt(parentId ? `New folder in ${t.crumb(parentId)}` : "New department", parentId ? "New folder" : "New department", "Create");
    if (!name?.trim()) return;
    try {
      const f = await api.folders.create({ name: name.trim(), parentId });
      if (parentId) setClosed(closed.filter((c) => c !== parentId));
      setNode(f.id);
      refresh();
    } catch (e) {
      ui.toast((e as Error).message);
    }
  };
  const rename = async (f: AppFolder) => {
    const name = await ui.prompt(`Rename ${f.parentId ? "folder" : "department"}`, f.name, "Rename");
    if (!name?.trim() || name.trim() === f.name) return;
    await api.folders.update(f.id, { name: name.trim() }).catch((e) => ui.toast((e as Error).message));
    refresh();
  };
  const shift = async (f: AppFolder, d: -1 | 1) => {
    const sib = (t.kids.get(f.parentId && t.byId.has(f.parentId) ? f.parentId : null) ?? []).map((x) => x.id);
    const i = sib.indexOf(f.id);
    const j = i + d;
    if (j < 0 || j >= sib.length) return;
    [sib[i], sib[j]] = [sib[j], sib[i]];
    await api.folders.reorder(sib);
    refresh();
  };
  const del = async (f: AppFolder, mode?: "move" | "delete") => {
    try {
      await api.folders.remove(f.id, mode);
      if (t.subtree(f.id).includes(node)) setNode(f.parentId ?? ALL);
      setDelFor(null);
      refresh();
      ui.toast(`Deleted ${f.name}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setDelFor({ f, n: +(/(\d+)/.exec(e.message)?.[1] ?? 0) });
      else ui.toast((e as Error).message);
    }
  };
  const renderNode = (f: AppFolder, depth: number): ReactElement => {
    const kids = t.kids.get(f.id) ?? [];
    const isClosed = closed.includes(f.id);
    const color = t.dept(f.id)?.options.color;
    return (
      <Fragment key={f.id}>
        <li className={[node === f.id && "sel", dropOn === f.id && "drop", !f.parentId && "dept"].filter(Boolean).join(" ")} style={{ paddingLeft: 4 + depth * 14 }}
          draggable onDragStart={(e) => e.dataTransfer.setData(DND_FOLDER, f.id)} {...dropProps(f.id)}>
          <button type="button" className="btn-ghost caret" aria-label={isClosed ? "Expand" : "Collapse"} disabled={!kids.length}
            onClick={() => setClosed(isClosed ? closed.filter((c) => c !== f.id) : [...closed, f.id])}>{kids.length ? (isClosed ? "▸" : "▾") : ""}</button>
          <button type="button" className="node" aria-pressed={node === f.id} title={f.options.description || t.crumb(f.id)} onClick={() => setNode(f.id)} onDoubleClick={() => rename(f)}>
            {!f.parentId ? <span className="dot" style={{ background: color ?? "var(--muted)" }} /> : <span className="fold">▤</span>}
            <span className="lbl">{f.name}</span>
            {f.options.code && <span className="code">{f.options.code}</span>}
            <span className="n">{countIn(f.id) || ""}</span>
          </button>
        </li>
        {!isClosed && kids.map((k) => renderNode(k, depth + 1))}
      </Fragment>
    );
  };

  // ---- instances of the node
  const inNode = (i: InstanceItem) => {
    if (node === ALL) return true;
    if (node === UNFILED) return !i.folderId || !t.byId.has(i.folderId);
    if (!t.byId.has(node)) return true;
    return sub ? !!i.folderId && t.subtree(node).includes(i.folderId) : i.folderId === node;
  };
  const ql = q.trim().toLowerCase();
  const list = instances.filter(inNode).filter((i) => !ql || i.name.toLowerCase().includes(ql) || String(latest(i.versions)?.meta?.source ?? "").toLowerCase().includes(ql))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sel = instances.find((i) => i.id === selId) ?? null;
  const vers = (sel?.versions ?? []).slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
  const ver = (selVer && vers.find((v) => verLabel(v) === selVer)) || latest(sel?.versions ?? []) || null;
  useEffect(() => setSelVer(""), [selId]);

  const create = async (name: string, folderId: string | null, copy: boolean) => {
    try {
      const it = await api.jsonInstances.create({ name, folderId } as Partial<InstanceItem> & { name: string });
      const data: JsInstance = copy && editorData ? editorData : emptyInstance();
      await api.jsonInstances.saveVersion(it.id, 1, 1, { stamp: stamp(), data, meta: instanceMeta(data) });
      setNewOpen(false);
      setSelId(it.id);
      refresh();
      ui.toast(`Created instance ${name} v1.001`);
    } catch (e) {
      ui.toast((e as Error).message);
    }
  };
  const duplicate = async (i: InstanceItem) => {
    const v = latest(i.versions);
    if (!v) return;
    const full = await api.jsonInstances.getVersion(i.id, v.major, v.minor);
    const it = await api.jsonInstances.create({ name: `${i.name} (copy)`, folderId: i.folderId } as Partial<InstanceItem> & { name: string });
    await api.jsonInstances.saveVersion(it.id, 1, 1, { stamp: stamp(), data: full.data, meta: v.meta });
    // Its conditioning sets are copied too (latest versions).
    let n = 0;
    for (const c of conds.filter((x) => x.instanceId === i.id)) {
      const cv = latest(c.versions);
      if (!cv) continue;
      const cf = await api.jsonConds.getVersion(c.id, cv.major, cv.minor);
      const nc = await api.jsonConds.create({ name: c.name, instanceId: it.id } as Partial<CondItem> & { name: string });
      await api.jsonConds.saveVersion(nc.id, 1, 1, { stamp: stamp(), data: cf.data, meta: cv.meta });
      n++;
    }
    setSelId(it.id);
    refresh();
    refreshConds();
    ui.toast(`Duplicated as ${it.name}${n ? ` with ${plural(n, "conditioning set")}` : ""}`);
  };

  // ---- conditioning sets of the selected instance; each one's output is computed on the instance document
  const [data] = useVersionData<JsInstance>(api.jsonInstances, [{ id: sel?.id ?? null, ver }], instances);
  const inst = data?.data ?? null;
  const parsed = useMemo(() => (inst?.source?.text?.trim() ? parseJson(inst.source.text) : null), [inst]);
  const doc = parsed?.ok ? parsed.value : undefined;
  const legacy = legacyOutputs(inst);
  const mine = useMemo(() => conds.filter((c) => sel && c.instanceId === sel.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [conds, sel]);
  const cd = useVersionData<CondSaved>(api.jsonConds, mine.map((c) => ({ id: c.id, ver: null })), mine);
  const sets = mine.map((c, i) => ({ c, v: latest(c.versions) ?? null, d: cd[i]?.data ?? null }));
  const lookups = sets.flatMap((x) => x.d?.lookups ?? []);
  const lk = useVersionData<JsSource>(api.jsonSources, lookups.map((l) => ({ id: l.sourceId, ver: l.ver })), srcItems);
  const libRefs = sets.flatMap((x) => x.d?.libs ?? []);
  const { codes: libCodes } = useLibCodes(libRefs, libItems, draftCode);
  const results = useMemo(() => {
    let k = 0;
    let m = 0;
    return sets.map(({ c, v, d }) => {
      const cond: JsCond = { ...emptyCond(), ...(d ?? {}) };
      const path = d?.array?.path ?? "";
      const tables: Record<string, JsTableData> = {};
      for (const l of cond.lookups) {
        const t = lk[k++]?.data;
        if (l.alias.trim() && t?.kind === "table") tables[l.alias.trim()] = { columns: t.columns ?? [], rows: t.rows ?? [] };
      }
      const codes = (cond.libs ?? []).map(() => libCodes[m++] ?? "");
      const base = { c, v, cond, path, loaded: !!d };
      if (doc === undefined || !path || !d) return { ...base, res: null };
      try {
        return { ...base, res: runCond(doc, path, cond, tables, { libs: codes }) };
      } catch (e) {
        return { ...base, res: null, err: (e as Error).message };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sets.map((x) => `${x.c.id}@${x.v ? verLabel(x.v) : ""}${x.d ? "+" : ""}`).join("|"), doc, lk.map((x) => x.key + (x.data ? "+" : "")).join("|"), libCodes.join("\u0000")]);
  const outSel = results.find((r) => r.c.id === outId) ?? results[0] ?? null;
  const library = conds.filter((c) => !c.instanceId).sort((a, b) => a.name.localeCompare(b.name));
  const attach = async (condId: string) => {
    if (!sel) return;
    await api.jsonConds.setInstance(condId, sel.id).catch((e) => ui.toast((e as Error).message));
    setOutId(condId);
    refreshConds();
  };
  const isOpen = !!sel && open.id === sel.id;

  return (
    <main className="jsv-inst">
      {/* 1 departments / folders */}
      <section className="pane" aria-label="Departments">
        <div className="pane-head"><h2>Departments</h2></div>
        <div className="toolbar sub wrap">
          <button type="button" onClick={() => addFolder(null)} title="New top-level department">+ Department</button>
          <button type="button" disabled={!selFolder} onClick={() => selFolder && addFolder(selFolder.id)} title="New folder inside the selected department / folder">+ Folder</button>
          <button type="button" disabled={!selFolder} onClick={() => selFolder && rename(selFolder)}>Rename</button>
          <button type="button" disabled={!selFolder} onClick={() => selFolder && setOptsFor(selFolder)}>Options…</button>
          <button type="button" className="btn-ghost" aria-label="Move up" disabled={!selFolder} onClick={() => selFolder && shift(selFolder, -1)}>↑</button>
          <button type="button" className="btn-ghost" aria-label="Move down" disabled={!selFolder} onClick={() => selFolder && shift(selFolder, 1)}>↓</button>
          {selFolder && <HoldButton label={`Delete ${selFolder.name}`} onHold={() => del(selFolder)}>✕</HoldButton>}
        </div>
        <div className="scroll">
          <ul className="inst-tree">
            <li className={[node === ALL && "sel", dropOn === ALL && "drop"].filter(Boolean).join(" ")} {...dropProps(ALL)}>
              <span className="caret" />
              <button type="button" className="node" aria-pressed={node === ALL} onClick={() => setNode(ALL)} title="Drop a folder here to make it a department">
                <span className="lbl">All instances</span><span className="n">{instances.length || ""}</span>
              </button>
            </li>
            {(t.kids.get(null) ?? []).map((f) => renderNode(f, 0))}
            <li className={[node === UNFILED && "sel", dropOn === UNFILED && "drop"].filter(Boolean).join(" ")} {...dropProps(UNFILED)}>
              <span className="caret" />
              <button type="button" className="node" aria-pressed={node === UNFILED} onClick={() => setNode(UNFILED)}>
                <span className="lbl muted">Unfiled</span><span className="n">{unfiled.length || ""}</span>
              </button>
            </li>
          </ul>
          <p className="muted hintp">Drag instances or folders onto a folder to move them. Double-click a name to rename.</p>
        </div>
      </section>

      {/* 2 instances */}
      <section className="pane" aria-label="Instances">
        <div className="pane-head">
          <h2>Instances</h2>
          <span className="hint">{node === ALL ? "All" : node === UNFILED ? "Unfiled" : t.crumb(node)}</span>
        </div>
        <div className="toolbar sub wrap">
          <button type="button" className="btn-primary" onClick={() => setNewOpen(true)}>+ Instance</button>
          <input type="search" aria-label="Filter instances" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 80 }} />
          {selFolder && <label className="ctl"><input type="checkbox" checked={sub} onChange={(e) => setSub(e.target.checked)} /> Sub-folders</label>}
        </div>
        <div className="scroll">
          <ul className="jsv-list">
            {list.map((i) => {
              const lv = latest(i.versions);
              const m = (lv?.meta ?? {}) as { source?: string; kb?: number };
              const nSets = conds.filter((c) => c.instanceId === i.id).length;
              const on = i.id === selId;
              return (
                <li key={i.id} className={on ? "on" : undefined} draggable onDragStart={(e) => e.dataTransfer.setData(DND_INST, i.id)}>
                  <button type="button" className="item" aria-current={on || undefined} onClick={() => setSelId(i.id)} onDoubleClick={() => lv && onOpen(i.id, lv, undefined, "sources")}>
                    <span className="nm">{i.name}{open.id === i.id && <span className="chip info">open{open.dirty ? " · unsaved" : ""}</span>}</span>
                    {(node === ALL || node === UNFILED || sub) && <span className="meta">{t.crumb(i.folderId)}</span>}
                    <span className="meta">{lv ? `v${verLabel(lv)} · ${plural(nSets, "conditioning set")}${m.source ? ` · ${m.source}` : ""}${m.kb != null ? ` · ${m.kb} KB` : ""}` : "no versions"}</span>
                    <span className="meta">{fmtDateTime(i.updatedAt)}</span>
                  </button>
                  {on && (
                    <div className="vers">
                      <select aria-label="Instance version" value={selVer} onChange={(e) => setSelVer(e.target.value)}>
                        <option value="">Latest{lv ? ` (v${verLabel(lv)})` : ""}</option>
                        {vers.map((v) => <option key={verLabel(v)} value={verLabel(v)}>v{verLabel(v)}{v.notes ? ` — ${v.notes.slice(0, 30)}` : ""}</option>)}
                      </select>
                      <button type="button" className="btn-primary" disabled={!ver} onClick={() => ver && onOpen(i.id, ver, undefined, "sources")}>{isOpen ? "Reopen" : "Open"}</button>
                      <button type="button" onClick={async () => {
                        const name = await ui.prompt("Rename instance", i.name, "Rename");
                        if (name?.trim() && name.trim() !== i.name) await api.jsonInstances.rename(i.id, name.trim()).catch((e) => ui.toast((e as Error).message));
                        refresh();
                      }}>Rename</button>
                      <button type="button" onClick={() => duplicate(i)}>Duplicate</button>
                      <HoldButton label={`Delete instance ${i.name}`} onHold={async () => {
                        await api.jsonInstances.remove(i.id);
                        setSelId("");
                        refresh();
                        ui.toast(`Deleted ${i.name}`);
                      }}>✕</HoldButton>
                    </div>
                  )}
                </li>
              );
            })}
            {!list.length && <li className="muted empty">{ql ? "No match." : "No instances here yet. + Instance creates one."}</li>}
          </ul>
        </div>
      </section>

      {/* 3 conditioning rules: the saved conditioning sets of the instance (each with its output) */}
      <section className="pane" aria-label="Conditioning rules">
        <div className="pane-head"><h2>Conditioning Rules</h2><span className="hint">{sel ? `${sel.name}${ver ? ` · document v${verLabel(ver)}` : ""}` : "Select an instance"}</span></div>
        {sel && (
          <div className="toolbar sub wrap">
            <button type="button" disabled={!ver} onClick={() => ver && onOpen(sel.id, ver, undefined, "structure")} title="Open the instance in 2 Structure to pick an array and save a new conditioning set">+ Conditioning set</button>
            <select aria-label="Attach a conditioning set" value="" onChange={(e) => e.target.value && attach(e.target.value)} disabled={!library.length}>
              <option value="">{library.length ? "Attach from library…" : "No library sets to attach"}</option>
              {library.map((c) => <option key={c.id} value={c.id}>{c.name}{(latest(c.versions)?.meta as { path?: string } | undefined)?.path ? ` · ${(latest(c.versions)!.meta as { path: string }).path}` : ""}</option>)}
            </select>
          </div>
        )}
        <div className="scroll">
          {sel && parsed && !parsed.ok && <span className="chip err">Document: {parsed.error}</span>}
          {sel && inst && !inst.source?.text?.trim() && <p className="muted hintp">This instance has no document yet — Open it and paste one in 1 Sources.</p>}
          {sel && legacy.length > 0 && <p className="chip hintp">{plural(legacy.length, "output")} saved in the pre-r25 format — Open the instance to convert {legacy.length === 1 ? "it" : "them"} to conditioning sets.</p>}
          <ul className="jsv-list">
            {results.map(({ c, v, cond, path, res, loaded, ...r }) => {
              const err = (r as { err?: string }).err;
              const on = outSel?.c.id === c.id;
              const editing = open.id === sel?.id && open.cond === c.id;
              return (
                <li key={c.id} className={on ? "on" : undefined}>
                  <button type="button" className="item" aria-current={on || undefined} onClick={() => setOutId(c.id)} onDoubleClick={() => ver && sel && onOpen(sel.id, ver, c.id, "output")}>
                    <span className="nm">{c.name}{editing && <span className="chip info">in editor</span>}</span>
                    <span className="meta">v{v ? verLabel(v) : "–"} · <code>{path || "no array recorded"}</code></span>
                    {cond.fields.length > 0 && (
                      <ol className="rules">
                        {cond.fields.slice(0, 12).map((f) => (
                          <li key={f.id} className={f.off ? "off" : undefined} title={f.off ? "Disabled" : undefined}>
                            <code>{f.target}</code><span className="muted"> ← {f.source ? <code>{f.source}</code> : "empty"} · {ruleText(f.rules)}</span>
                          </li>
                        ))}
                        {cond.fields.length > 12 && <li className="muted">… {cond.fields.length - 12} more</li>}
                      </ol>
                    )}
                    <span className="meta">{loaded ? `${plural(cond.fields.length, "field")}${cond.lookups.length ? ` · ${plural(cond.lookups.length, "lookup")}` : ""}${(cond.libs ?? []).length ? ` · ${cond.libs!.length} ${cond.libs!.length === 1 ? "library" : "libraries"}` : ""}` : "Loading…"}</span>
                    {res ? (
                      <span className="meta">Output: {res.changed}/{res.elems.length} elements changed{res.warnings ? <span className="chip"> {plural(res.warnings, "warning")}</span> : null}</span>
                    ) : err ? <span className="chip err">{err}</span> : path && doc !== undefined && loaded ? <span className="chip">array not in document</span> : null}
                  </button>
                  {on && sel && ver && (
                    <div className="vers">
                      <HoldButton label={`Detach ${c.name} (keep it as a library template)`} onHold={async () => {
                        await api.jsonConds.setInstance(c.id, null).catch((e) => ui.toast((e as Error).message));
                        refreshConds();
                        ui.toast(`${c.name} moved to the library`);
                      }}>Detach</HoldButton>
                      <span className="grow" />
                      <button type="button" onClick={() => onOpen(sel.id, ver, c.id, "array")}>3 Conditioning →</button>
                      <button type="button" className="btn-primary" onClick={() => onOpen(sel.id, ver, c.id, "output")}>4 Output →</button>
                    </div>
                  )}
                </li>
              );
            })}
            {sel && !results.length && <li className="muted empty">No conditioning sets yet. + Conditioning set, or attach one from the library.</li>}
          </ul>
        </div>
      </section>

      {/* 4 output content */}
      <OutputView name={sel && outSel ? `${sel.name}_${outSel.c.name}` : ""} r={outSel} hasDoc={doc !== undefined} />

      {newOpen && <NewInstanceModal folders={folders} folderId={selFolder?.id ?? (node === UNFILED ? null : t.kids.get(null)?.[0]?.id ?? null)} canCopy={!!editorData} onCreate={create} onClose={() => setNewOpen(false)} />}
      {optsFor && <FolderModal folder={optsFor} folders={folders} onClose={() => setOptsFor(null)} onSaved={refresh} />}
      {delFor && (
        <Modal onClose={() => setDelFor(null)} label="Delete folder" size="sm">
          <div className="mh"><h3>Delete {delFor.f.name}?</h3></div>
          <div className="mb"><p>{delFor.f.name} and its sub-folders hold {plural(delFor.n, "instance")}.</p></div>
          <div className="mf">
            <button type="button" onClick={() => setDelFor(null)}>Cancel</button>
            <button type="button" onClick={() => del(delFor.f, "delete")}>Delete the instances too</button>
            <button type="button" className="btn-primary" onClick={() => del(delFor.f, "move")}>Move them to {delFor.f.parentId ? t.crumb(delFor.f.parentId) : "Unfiled"} and delete</button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function OutputView({ name, r, hasDoc }: { name: string; r: { path: string; res: ReturnType<typeof runCond> | null; err?: string } | null; hasDoc: boolean }) {
  const ui = useUi();
  const [show, setShow] = useLocal<"changes" | "json" | "array">("fpl.json.inst.show", "changes");
  const res = r?.res ?? null;
  const text = useMemo(() => (res ? JSON.stringify(res.out, null, 2) : ""), [res]);
  const arrText = useMemo(() => {
    if (!res) return "";
    return JSON.stringify(res.elems.map((e) => Object.fromEntries(Object.entries(e.fields).map(([k, f]) => [k, f.after]))), null, 2);
  }, [res]);
  const changes = res ? res.elems.flatMap((e) => Object.entries(e.fields).filter(([, f]) => JSON.stringify(f.before) !== JSON.stringify(f.after) || f.warn.length).map(([k, f]) => ({ ptr: e.ptr, k, f }))) : [];
  const pre = useRef<HTMLPreElement>(null);
  const body = show === "json" ? text : arrText;
  return (
    <section className="pane" aria-label="Output content">
      <div className="pane-head">
        <h2>Content</h2>
        {res && <span className="hint">{plural(res.changed, "element")} of {res.elems.length} changed · {plural(res.warnings, "warning")} · {(text.length / 1024).toFixed(1)} KB</span>}
      </div>
      {res ? (
        <>
          <div className="toolbar sub wrap">
            <Seg<"changes" | "array" | "json"> label="Show" value={show} onChange={setShow} options={[["changes", `Changes (${changes.length})`], ["array", "Written keys"], ["json", "Full JSON"]]} />
            <span className="grow" />
            <button type="button" onClick={async () => ui.toast((await navigator.clipboard.writeText(text).then(() => true, () => false)) ? "JSON copied" : "Copy blocked")}>Copy</button>
            <button type="button" onClick={() => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
              a.download = `${name.replace(/[^\w.-]+/g, "_") || "output"}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }}>Download</button>
          </div>
          <div className="scroll">
            {show === "changes" ? (
              <table className="vt jsv-changes">
                <thead><tr><th>Element</th><th>Key</th><th>Before</th><th>After</th></tr></thead>
                <tbody>
                  {changes.slice(0, 1000).map((c, k) => (
                    <tr key={k} className={c.f.warn.length ? "bad" : undefined} title={c.f.warn.join("\n") || undefined}>
                      <td className="mono">{c.ptr}</td><td className="mono">{c.k}</td><td className="mono">{shortJson(c.f.before, 40)}</td><td className="mono">{shortJson(c.f.after, 60)}{c.f.warn.length ? <div className="chip err">{c.f.warn[0]}</div> : null}</td>
                    </tr>
                  ))}
                  {!changes.length && <tr><td colSpan={4} className="muted">No changes.</td></tr>}
                </tbody>
              </table>
            ) : (
              <pre ref={pre} className="jsv-out">{body.length > 400_000 ? body.slice(0, 400_000) + "\n… (truncated; Download gives the full file)" : body}</pre>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state"><h3>{r ? (r.err ? "Error" : hasDoc ? "No result" : "No document") : "No output selected"}</h3><p>{r?.err ?? (r ? (r.path ? "The array of this conditioning set is not in the instance's document." : "This conditioning set has no array recorded — load it in 2 Structure, select its array and save.") : "Select an instance and one of its conditioning rule sets.")}</p></div>
      )}
    </section>
  );
}
