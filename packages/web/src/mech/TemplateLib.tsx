import { ASM_KINDS, cloneNode, explode, findNode, latest, type AsmKind, type AsmTemplate, type BomNode } from "@fpl/core";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg, type AsmItem } from "../api";
import { fmtN, type Catalog } from "../bom/shared";
import { useBomDoc } from "../bom/store";
import { useLocal, useUi } from "../ui";
import { AsmEditor, AsmPreview } from "./AsmEditor";
import { masterBatch, templateCopy } from "./asmBuild";
import { useSplit, type Len } from "./common";
import { NewGroupDialog } from "./NewGroupDialog";

interface FolderNode {
  path: string;
  name: string;
  kids: FolderNode[];
}
function folderTree(paths: string[]): FolderNode[] {
  const root: FolderNode = { path: "", name: "", kids: [] };
  for (const p of [...paths].sort((a, b) => a.localeCompare(b))) {
    let cur = root;
    const parts = p.split("/");
    parts.forEach((nm, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let k = cur.kids.find((x) => x.path === path);
      if (!k) cur.kids.push((k = { path, name: nm, kids: [] }));
      cur = k;
    });
  }
  return root.kids;
}

/**
 * Template library: folder directory (left), front / rear preview or the layout editor (middle), properties and notes
 * (right, top) and the parts list of all components (right, bottom).
 */
export function TemplateLib({ cat, len, tpls, refreshTpls, cur, draft, setDraft, load, onNew }: {
  cat: Catalog; len: Len; tpls: AsmItem[]; refreshTpls: () => void; cur: string | null;
  draft: AsmTemplate; setDraft: (f: (d: AsmTemplate) => AsmTemplate) => void;
  load: (id: string) => void; onNew: (folder: string) => void;
}) {
  const ui = useUi();
  const [doc] = useBomDoc();
  const split = useSplit("tpllib", 280, 380);
  const [folders, setFolders] = useState<string[]>([]);
  const [open, setOpen] = useLocal<string[]>("fpl.mech.tplopen", []);
  const [folder, setFolder] = useLocal<string>("fpl.mech.tplfolder", "");
  const [mode, setMode] = useLocal<"preview" | "edit">("fpl.mech.tplmode", "preview");
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const refreshFolders = () => api.asmFolders.list().then(setFolders).catch(() => {});
  useEffect(() => void refreshFolders(), [tpls]);
  const tree = useMemo(() => folderTree([...folders, ...tpls.map((t) => t.folder).filter(Boolean)]), [folders, tpls]);
  const item = tpls.find((t) => t.id === cur);
  const lines = useMemo(() => explode([draft.root], cat.ctx).filter((l) => l.kind === "part"), [draft.root, cat.ctx]);
  const ql = q.trim().toLowerCase();
  const tplsIn = (path: string) => tpls.filter((t) => (t.folder || "") === path && (!ql || `${t.code} ${t.name}`.toLowerCase().includes(ql)));
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      ui.toast(errMsg(e));
    }
    refreshFolders();
    refreshTpls();
  };
  const addFolder = async () => {
    const nm = await ui.prompt(`New folder in ${folder || "/ (root)"}`, "", "Create");
    if (!nm?.trim()) return;
    const path = folder ? `${folder}/${nm.trim()}` : nm.trim();
    await act(() => api.asmFolders.create(path));
    setOpen((o) => [...new Set([...o, folder].filter(Boolean))]);
    setFolder(path);
  };
  const renameFolder = async () => {
    if (!folder) return;
    const base = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/") + 1) : "";
    const nm = await ui.prompt("Rename folder", folder.slice(base.length), "Rename");
    if (!nm?.trim()) return;
    await act(() => api.asmFolders.move(folder, base + nm.trim()));
    setFolder(base + nm.trim());
  };
  const delFolder = async () => {
    if (!folder || !(await ui.confirm(`Delete the folder “${folder}”? Its templates and sub-folders move to the parent folder.`, "Delete"))) return;
    await act(() => api.asmFolders.remove(folder));
    setFolder(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "");
  };
  const moveTpl = (id: string, to: string) => act(() => api.bomAssemblies.setMeta(id, { folder: to }));

  const Tpl = ({ t }: { t: AsmItem }) => {
    const v = latest(t.versions);
    return (
      <li className={`tplrow${t.id === cur ? " sel" : ""}`} draggable onDragStart={(e) => e.dataTransfer.setData("application/x-fpl-tpl", t.id)} onClick={() => load(t.id)} title="Open (drag onto a folder to move)">
        <span className="ico">▦</span><span className="nm">{t.code ? <span className="mono">{t.code} </span> : null}{t.name}</span><span className="muted">{v ? `v${v.major}.${v.minor}` : ""}</span>
      </li>
    );
  };
  const drop = (path: string) => ({
    onDragOver: (e: React.DragEvent) => e.dataTransfer.types.includes("application/x-fpl-tpl") && e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData("application/x-fpl-tpl");
      if (id) (e.preventDefault(), moveTpl(id, path));
    },
  });
  const Folder = ({ f, depth }: { f: FolderNode; depth: number }) => {
    const isOpen = open.includes(f.path) || !!ql;
    return (
      <li>
        <div className={`fold${folder === f.path ? " sel" : ""}`} style={{ paddingLeft: 4 + depth * 14 }} onClick={() => setFolder(f.path)} {...drop(f.path)}>
          <button type="button" className="btn-ghost twisty" aria-label={isOpen ? `Collapse ${f.name}` : `Expand ${f.name}`} onClick={(e) => (e.stopPropagation(), setOpen((o) => (o.includes(f.path) ? o.filter((x) => x !== f.path) : [...o, f.path])))}>{isOpen ? "▾" : "▸"}</button>
          <span className="ico">📁</span>{f.name}
        </div>
        {isOpen && (
          <ul className="tlib">
            {f.kids.map((k) => <Folder key={k.path} f={k} depth={depth + 1} />)}
            {tplsIn(f.path).map((t) => <div key={t.id} style={{ paddingLeft: 18 + depth * 14 }}><Tpl t={t} /></div>)}
          </ul>
        )}
      </li>
    );
  };

  const modeSeg = (
    <div className="seg" role="group" aria-label="Mode">
      <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Library &amp; preview</button>
      <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>Edit layout</button>
    </div>
  );
  if (mode === "edit")
    return (
      <>
        <div className="toolbar sub">
          <b>{draft.root.name || "(template)"}</b>{modeSeg}
          <button type="button" onClick={() => setAdding(true)}>+ Add parts…</button>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{item ? "Save changes with the template version bar above." : "Unsaved template — save it with the version bar above."}</span>
        </div>
        <AsmEditor key={`tpl${cur ?? ""}`} splitKey="tpled" group={draft.root} setGroup={(f) => setDraft((d) => ({ ...d, root: f(d.root) }))} cat={cat} len={len} />
        {adding && (
          <NewGroupDialog title={`Add to ${draft.root.name || "template"}`} existing units={doc.units.filter((u) => !u.mechUndef)} cat={cat} templates={tpls.filter((t) => t.id !== cur)}
            onClose={() => setAdding(false)}
            onDone={async (r) => {
              setAdding(false);
              const add: BomNode[] = [];
              for (const id of r.sources) {
                const n = findNode(doc.units, id)?.node;
                if (n) add.push({ ...cloneNode(n), tags: [] });
              }
              const mb = masterBatch(r.masters, cat);
              if (mb) add.push(mb);
              for (const t of r.templates) {
                const c = await templateCopy(t).catch(() => null);
                if (c) add.push({ ...c.root, layout: null });
              }
              setDraft((d) => ({ ...d, root: { ...d.root, children: [...d.root.children, ...add] } }));
            }} />
        )}
      </>
    );
  return (
    <div className="mechwrap tpllib" style={{ gridTemplateColumns: split.cols }}>
      <section className="pane mpal">
        <div className="pane-head">
          <h3>Library</h3><span className="grow" />
          <button type="button" className="btn-ghost" onClick={addFolder} title={`New folder in ${folder || "/"}`}>+ Folder</button>
          <button type="button" className="btn-ghost" onClick={() => onNew(folder)} title={`New template in ${folder || "/"}`}>+ Template</button>
        </div>
        <div className="toolbar sub" style={{ padding: "4px 8px" }}>
          <input type="search" placeholder="Search templates" aria-label="Search templates" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          {folder && <button type="button" className="btn-ghost" onClick={renameFolder} title="Rename the selected folder">✎</button>}
          {folder && <button type="button" className="btn-ghost btn-danger" onClick={delFolder} aria-label="Delete folder" title="Delete the selected folder">🗑</button>}
        </div>
        <div className="scroll">
          <ul className="tlib">
            <li>
              <div className={`fold${folder === "" ? " sel" : ""}`} onClick={() => setFolder("")} {...drop("")}><span className="ico">🗂</span>/ (root)</div>
              <ul className="tlib">
                {tree.map((f) => <Folder key={f.path} f={f} depth={1} />)}
                {tplsIn("").map((t) => <div key={t.id} style={{ paddingLeft: 18 }}><Tpl t={t} /></div>)}
              </ul>
            </li>
          </ul>
        </div>
        {split.handle}
      </section>
      <section className="pane mcanvas">
        <div className="toolbar sub">
          <b>{draft.root.name || "(template)"}</b>
          {modeSeg}
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{item ? "Save changes with the template version bar above." : "Unsaved template — save it with the version bar above."}</span>
        </div>
        <AsmPreview group={draft.root} cat={cat} />
      </section>
      <section className="pane minsp tplside">
        {split.rightHandle}
        <div className="tplprops">
          <div className="pane-head"><h3>Properties</h3></div>
          <div className="inspf">
            <label className="f">Name<input type="text" value={draft.root.name} onChange={(e) => setDraft((d) => ({ ...d, root: { ...d.root, name: e.target.value } }))}
              onBlur={() => item && draft.root.name.trim() && draft.root.name !== item.name && act(() => api.bomAssemblies.rename(item.id, draft.root.name.trim()))} /></label>
            <div className="frow tight">
              <label className="f">Code<input type="text" defaultValue={item?.code ?? ""} key={`c${item?.id}`} disabled={!item} onBlur={(e) => item && e.target.value !== item.code && act(() => api.bomAssemblies.setMeta(item.id, { code: e.target.value }))} style={{ width: 110 }} /></label>
              <label className="f">Kind<select value={draft.kind} onChange={(e) => {
                const k = e.target.value as AsmKind;
                setDraft((d) => ({ ...d, kind: k }));
                if (item) act(() => api.bomAssemblies.setMeta(item.id, { kind: k }));
              }}>{ASM_KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
            </div>
            <label className="f">Folder
              <select value={item?.folder ?? folder} disabled={!item} onChange={(e) => item && moveTpl(item.id, e.target.value)}>
                <option value="">/ (root)</option>
                {[...new Set([...folders, ...tpls.map((t) => t.folder).filter(Boolean)])].sort().map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <div className="kv">
              <span>Mounting</span><b>{draft.root.layout ? (draft.root.layout.mount === "rack" ? `Rack-mounted ${draft.root.layout.rackUnits}U (front + rear)` : draft.root.layout.mount === "rail" ? "Rail group (no DIN rail)" : "DIN-rail assembly") : "no layout"}</b>
              <span>Size</span><b>{draft.root.layout ? `${fmtN(draft.root.layout.widthMm, 0)} × ${fmtN(draft.root.layout.heightMm, 0)}${draft.root.layout.depthMm ? ` × ${fmtN(draft.root.layout.depthMm, 0)}` : ""} mm` : "—"}</b>
              <span>Lines / devices</span><b>{lines.length} / {lines.reduce((s, l) => s + (l.perUnit || 0), 0)}</b>
              {item && <><span>Versions</span><b>{item.versions.length} (latest v{latest(item.versions)?.major}.{latest(item.versions)?.minor})</b></>}
            </div>
            <label className="f">Notes<textarea rows={4} value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} placeholder="Wiring notes, application, ordering remarks… (saved with the version)" /></label>
          </div>
        </div>
        <div className="tplparts">
          <div className="pane-head"><h3>Parts ({lines.length})</h3></div>
          <div className="scroll">
            <table className="mini wide">
              <thead><tr><th>No.</th><th>Manufacturer</th><th>Part number</th><th className="c-desc">Description</th><th>Qty</th></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.nodeId}${i}`}>
                    <td className="mono">{l.itemNo}</td><td>{l.manufacturer}</td><td className="mono">{l.partNumber}</td><td className="c-desc">{l.description}</td><td>{l.qty}</td>
                  </tr>
                ))}
                {!lines.length && <tr><td colSpan={5} className="muted">No parts.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
