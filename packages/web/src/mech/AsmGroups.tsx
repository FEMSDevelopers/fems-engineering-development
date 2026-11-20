import {
  ASM_KINDS, asmCheck, asmGroupRoot, cloneNode, emptyAsmLayout, emptyAsmSet, explode, findNode, itemNumbers, latest, newAsmGroup, nodeIdentity, stamp, unitLabelOf, unitOfNode, verLabel, walk,
  type AsmGroup, type AsmKind, type AsmLink, type AsmSet, type AsmTemplate, type BomDoc, type BomNode,
} from "@fpl/core";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg, type AsmItem, type Versioned } from "../api";
import { PROJ_KEY } from "../bom/BomView";
import type { Catalog } from "../bom/shared";
import { useBomDoc } from "../bom/store";
import { Modal, useLocal, useUi } from "../ui";
import { AsmEditor, sourceLabel } from "./AsmEditor";
import { masterBatch, templateCopy } from "./asmBuild";
import type { Len } from "./common";
import { NewGroupDialog } from "./NewGroupDialog";

/** Units of the linked saved project BOM version (the open draft when the link follows the latest version of the open project). */
export function useLinkedBom(link: AsmLink | null, openUnits: BomNode[], openId: string | null, nonce: number) {
  const [st, setSt] = useState<{ units: BomNode[]; ver: string; stage: string; err: string }>({ units: [], ver: "", stage: "", err: "" });
  const live = !!link && link.major == null && link.projectId === openId;
  const key = link ? `${link.projectId}|${link.major ?? "L"}|${link.minor ?? ""}|${nonce}` : "";
  useEffect(() => {
    if (!link || live) return setSt({ units: [], ver: "", stage: "", err: "" });
    let on = true;
    (async () => {
      try {
        let v = link.major != null && link.minor != null ? { major: link.major, minor: link.minor } : null;
        if (!v) {
          const p = await api.bomProjects.get(link.projectId);
          const l = latest(p.versions);
          if (!l) throw new Error("The linked project has no saved versions");
          v = { major: l.major, minor: l.minor };
        }
        const r = await api.bomProjects.getVersion(link.projectId, v.major, v.minor);
        const d = r.data as BomDoc;
        if (on) setSt({ units: d.units, ver: verLabel(v), stage: d.stage, err: "" });
      } catch (e) {
        if (on) setSt({ units: [], ver: "", stage: "", err: errMsg(e) });
      }
    })();
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live]);
  return { ...st, units: live ? openUnits.filter((u) => !u.mechUndef) : st.units.filter((u) => !u.mechUndef), live };
}

/** Pick a saved project BOM and version (or "latest") as the link of the assembly groups. */
export function LinkDialog({ current, onClose, onDone }: { current: AsmLink | null; onClose: () => void; onDone: (l: AsmLink) => void }) {
  const [projects, setProjects] = useState<Versioned[]>([]);
  const [pid, setPid] = useState(current?.projectId ?? "");
  const [ver, setVer] = useState(current ? (current.major != null ? `${current.major}.${current.minor}` : "latest") : "latest");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.bomProjects.list().then((l) => {
      setProjects(l);
      if (!pid) {
        let open = "";
        try {
          open = JSON.parse(localStorage.getItem(PROJ_KEY) ?? "{}").id ?? "";
        } catch {
          /* none */
        }
        setPid(l.find((p) => p.id === open)?.id ?? l[0]?.id ?? "");
      }
    }).catch((e) => setErr(errMsg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const proj = projects.find((p) => p.id === pid);
  return (
    <Modal size="sm" onClose={onClose} label="Link a project BOM version">
      <div className="mh"><h3>Link a saved project BOM version</h3></div>
      <div className="mb">
        <label className="f">Saved project BOM
          <select value={pid} onChange={(e) => setPid(e.target.value)}>
            {!projects.length && <option value="">(no saved project BOMs)</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="f">Version / sub-version
          <select value={ver} onChange={(e) => setVer(e.target.value)}>
            <option value="latest">Latest (follows new saves)</option>
            {proj?.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor).map((v) => <option key={`${v.major}.${v.minor}`} value={`${v.major}.${v.minor}`}>v{verLabel(v)}{v.meta?.stage ? ` (${String(v.meta.stage)})` : ""}{v.notes ? ` — ${v.notes.slice(0, 40)}` : ""}</option>)}
          </select>
        </label>
        {err && <p className="errtxt" style={{ margin: 0 }}>{err}</p>}
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The link supplies the BOM groups / sub-assemblies the assembly groups are composed of and validates quantities (BOM vs. placed). Devices that are not on the BOM can still be added to a group.</p>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!proj} onClick={() => proj && onDone({ projectId: proj.id, projectName: proj.name, major: ver === "latest" ? null : Number(ver.split(".")[0]), minor: ver === "latest" ? null : Number(ver.split(".")[1]) })}>Link</button>
      </div>
    </Modal>
  );
}

/** Save an assembly (with its layout) to the template library. */
export function SaveTemplateDialog({ root, defaultKind, onClose }: { root: BomNode; defaultKind: AsmKind; onClose: () => void }) {
  const ui = useUi();
  const [name, setName] = useState(root.name || "ASSEMBLY");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<AsmKind>(defaultKind);
  const [folders, setFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.asmFolders.list().then(setFolders).catch(() => {}), []);
  const save = async () => {
    setBusy(true);
    try {
      // Fresh ids; device tags of the project are dropped (a template is project-neutral).
      const c = cloneNode(root);
      const strip = (n: BomNode): BomNode => ({ ...n, tags: n.kind === "part" ? [] : n.tags, mechTags: undefined, bomNodeId: undefined, links: undefined, children: n.children.map(strip) });
      const data: AsmTemplate = { kind, root: { ...strip(c), name }, notes };
      const t = await api.bomAssemblies.create({ name, kind, code, folder } as Partial<AsmItem> & { name: string });
      await api.bomAssemblies.saveVersion(t.id, 1, 1, { stamp: stamp(), data, meta: { kind, lines: explode([data.root]).filter((l) => l.kind === "part").length } });
      ui.toast(`Saved “${name}” to the template library${folder ? ` (${folder})` : ""} as v1.1`);
      onClose();
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" onClose={onClose} label="Save to the template library">
      <div className="mh"><h3>Save to the template library</h3></div>
      <div className="mb">
        <label className="f">Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="frow tight">
          <label className="f">Code<input type="text" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 120 }} /></label>
          <label className="f">Kind<select value={kind} onChange={(e) => setKind(e.target.value as AsmKind)}>{ASM_KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        </div>
        <label className="f">Folder
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">/ (root)</option>
            {folders.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="f">Notes<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The parts, the layout (rails, arrays, colours) are saved; device tags are not.</p>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/**
 * Quantity check of a group against the linked BOM (first tab of the right panel). "Recent first" lists the selected
 * device's line first, then the lines by most recently placed / moved; off = part-line order.
 */
function CheckPanel({ g, units, all, cat, nos, sel }: { g: AsmGroup; units: BomNode[]; all: AsmGroup[]; cat: Catalog; nos: Map<string, string>; sel: string | null }) {
  const c = useMemo(() => asmCheck(g, units, cat.ctx, all), [g, units, cat.ctx, all]);
  const [recent, setRecent] = useLocal<boolean>("fpl.mech.checkrecent", false);
  const last = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of g.layout?.items ?? []) if (it.t) m.set(it.nodeId, Math.max(m.get(it.nodeId) ?? 0, it.t));
    return m;
  }, [g.layout]);
  const order = <T extends { node: BomNode }>(rows: T[]): T[] => {
    const byLine = (a: T, b: T) => natural.compare(nos.get(a.node.id) ?? "~", nos.get(b.node.id) ?? "~");
    if (!recent) return rows.slice().sort(byLine);
    return rows.slice().sort((a, b) => {
      if (a.node.id === sel) return -1;
      if (b.node.id === sel) return 1;
      return (last.get(b.node.id) ?? 0) - (last.get(a.node.id) ?? 0) || byLine(a, b);
    });
  };
  const ago = (id: string) => {
    const t = last.get(id);
    if (!t) return "";
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
  };
  return (
    <div className="asmcheck">
      <div className="ckhead">
        <b>BOM check</b> {c.ok ? <span className="chip ok">quantities match</span> : <span className="chip warn">{c.rows.filter((r) => r.status !== "ok").length + c.missing.length} to review</span>}
        <span className="grow" />
        <label className="switch" title="On: the selected device's line first, then the lines most recently placed or moved. Off: part-line order.">
          <input type="checkbox" role="switch" aria-label="Recent first" checked={recent} onChange={(e) => setRecent(e.target.checked)} /> Recent first
        </label>
      </div>
      {c.missing.length > 0 && <p className="errtxt" style={{ margin: "4px 0", fontSize: 12 }}>{c.missing.length} source(s) no longer in the linked BOM.</p>}
      {c.shared.map((s) => <p key={s.id} className="warntxt" style={{ margin: "4px 0", fontSize: 12 }}>{nos.get(s.id) ?? ""} {findNode(units, s.id)?.node.name ?? ""} is also in {s.groups.join(", ")}.</p>)}
      <table className="mini wide">
        <thead><tr><th>No.</th><th>Part number</th><th title="Quantity on the linked BOM">BOM</th><th title="Placed in this layout (front + rear)">Placed</th>{recent && <th>Last moved</th>}</tr></thead>
        <tbody>
          {order(c.rows).map((r) => (
            <tr key={r.node.id} className={`st-${r.status}${r.node.id === sel ? " selrow" : ""}`}>
              <td className="mono">{nos.get(r.node.id)}</td>
              <td className="mono" title={nodeIdentity(r.node, cat.ctx).description}>{nodeIdentity(r.node, cat.ctx).partNumber}</td>
              <td>{r.bom}</td>
              <td className={r.status === "ok" ? "" : r.status === "short" ? "warntxt" : "errtxt"}>{r.placed}{r.status === "short" ? " ▼" : r.status === "over" ? " ▲" : " ✓"}</td>
              {recent && <td className="muted">{ago(r.node.id)}</td>}
            </tr>
          ))}
          {order(c.extras).map((r) => (
            <tr key={r.node.id} className={`extra${r.node.id === sel ? " selrow" : ""}`} title="Not on the BOM: listed under UNDEFINED MECHANICAL PARTS of the unit">
              <td className="muted">+</td>
              <td className="mono">{nodeIdentity(r.node, cat.ctx).partNumber}</td>
              <td className="muted">—</td>
              <td>{r.placed}/{r.qty}</td>
              {recent && <td className="muted">{ago(r.node.id)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Mechanical Design → Assemblies → Project BOM groups: assembly groups of the open project, composed of BOM groups /
 * sub-assemblies of a linked saved BOM version (plus free extras), each with its own layout. Saved with the project BOM.
 */
export function AsmGroups({ cat, len, tpls, refreshTpls }: { cat: Catalog; len: Len; tpls: AsmItem[]; refreshTpls: () => void }) {
  const ui = useUi();
  const [doc, setDoc] = useBomDoc();
  const set: AsmSet = doc.assemblies ?? emptyAsmSet();
  const setSet = (f: (s: AsmSet) => AsmSet) => setDoc((d: BomDoc) => ({ ...d, assemblies: f(d.assemblies ?? emptyAsmSet()) }));
  const [nonce, setNonce] = useState(0);
  let openId: string | null = null;
  try {
    openId = JSON.parse(localStorage.getItem(PROJ_KEY) ?? "{}").id ?? null;
  } catch {
    /* none */
  }
  const bom = useLinkedBom(set.link, doc.units, openId, nonce);
  const nos = useMemo(() => itemNumbers(bom.units), [bom.units]);
  const [cur, setCur] = useLocal<string>("fpl.mech.asmgroup", "");
  const g = set.groups.find((x) => x.id === cur) ?? set.groups[0];
  const [dlg, setDlg] = useState<"link" | "new" | "add" | "save" | null>(null);
  const root = useMemo(() => (g ? asmGroupRoot(g, bom.units).root : null), [g, bom.units]);
  const setG = (id: string, f: (g: AsmGroup) => AsmGroup) => setSet((s) => ({ ...s, groups: s.groups.map((x) => (x.id === id ? f(x) : x)) }));
  const legacy = useMemo(() => {
    const l: BomNode[] = [];
    for (const u of doc.units) walk(u.children, (n) => n.kind === "group" && n.layout && l.push(n));
    return l;
  }, [doc.units]);

  const build = async (r: Parameters<Parameters<typeof NewGroupDialog>[0]["onDone"]>[0]) => {
    const extras: BomNode[] = [];
    const mb = masterBatch(r.masters, cat);
    if (mb) extras.push(mb);
    let tplLayout = null;
    for (const t of r.templates) {
      const c = await templateCopy(t).catch(() => null);
      if (!c) continue;
      if (r.templates.length === 1 && !r.sources.length && !mb && c.root.layout) tplLayout = c.root.layout;
      extras.push({ ...c.root, layout: null });
    }
    return { extras, tplLayout };
  };

  const unitLbl = g ? (() => {
    const u = g.sources.map((s) => unitOfNode(bom.units, s)).find((x) => !!x);
    return u ? unitLabelOf(u) : "";
  })() : "";

  return (
    <>
      <div className="toolbar sub asmbar">
        <span className="muted" style={{ fontSize: 12.5 }}>Linked BOM:</span>
        {set.link ? (
          <b className={bom.err ? "errtxt" : undefined} title={bom.err || "Used only to compose the groups and to check quantities"}>
            {set.link.projectName} {set.link.major != null ? `v${verLabel({ major: set.link.major, minor: set.link.minor ?? 1 })}` : `latest${bom.ver ? ` (v${bom.ver})` : ""}`}{bom.stage ? ` (${bom.stage})` : ""}
            {bom.live && <span className="chip info" style={{ marginLeft: 6 }} title="Follows the latest version of the project open in Parts & BOM: the open draft is used">live</span>}
            {bom.err ? " — can't load" : ""}
          </b>
        ) : <span className="muted">none</span>}
        <button type="button" className="btn-ghost" onClick={() => setDlg("link")}>{set.link ? "Change…" : "Link a BOM version…"}</button>
        {set.link && <button type="button" className="btn-ghost" aria-label="Reload the linked BOM" title="Reload the linked BOM" onClick={() => setNonce((n) => n + 1)}>↻</button>}
        <span className="sep" />
        <label className="ctl">Group
          <select aria-label="Assembly group" value={g?.id ?? ""} onChange={(e) => setCur(e.target.value)} style={{ maxWidth: 360 }}>
            {!set.groups.length && <option value="">(no groups yet)</option>}
            {set.groups.map((x) => {
              const c = asmCheck(x, bom.units, cat.ctx);
              return <option key={x.id} value={x.id}>{x.name}{x.layout ? ` · ${x.layout.mount === "rack" ? `${x.layout.rackUnits}U RMU` : x.layout.mount === "rail" ? "rail group" : "DIN"}` : ""}{set.link ? (c.ok ? " ✓" : " ⚠") : ""}</option>;
            })}
          </select>
        </label>
        <button type="button" className="btn-primary" onClick={() => setDlg("new")}>+ New group…</button>
        {g && <button type="button" onClick={() => setDlg("add")} title="Add BOM groups / part lines, master parts or a template to this group">+ Add…</button>}
        {g && <button type="button" className="btn-ghost" onClick={async () => {
          const v = await ui.prompt("Group name", g.name, "Rename");
          if (v?.trim()) setG(g.id, (x) => ({ ...x, name: v.trim() }));
        }}>Rename</button>}
        {g && <button type="button" className="btn-ghost" onClick={() => setDlg("save")} title="Save this group (parts and layout) to the template library">Save to library…</button>}
        {g && <button type="button" className="btn-ghost btn-danger" onClick={async () => {
          if (await ui.confirm(`Delete the assembly group “${g.name}” and its layout?`, "Delete")) setSet((s) => ({ ...s, groups: s.groups.filter((x) => x.id !== g.id) }));
        }}>Delete</button>}
        <span className="grow" />
        {unitLbl && <span className="muted" style={{ fontSize: 12 }}>Unit: {unitLbl}</span>}
      </div>
      {g && root ? (
        <>
          {g.sources.length > 0 && (
            <div className="toolbar sub srcchips">
              <span className="muted" style={{ fontSize: 12 }}>Composed of:</span>
              {root.children.map((c) => {
                const isSrc = g.sources.includes(c.id);
                return (
                  <span key={c.id} className={`chip${isSrc ? "" : " info"}`}>
                    {sourceLabel(c, cat, nos)}{!isSrc ? " (added)" : ""}
                    <button type="button" className="btn-ghost chipx" aria-label={`Remove ${sourceLabel(c, cat, nos)}`} onClick={() => setG(g.id, (x) => ({
                      ...x, sources: x.sources.filter((s) => s !== c.id), extras: x.extras.filter((e) => e.id !== c.id),
                      layout: x.layout ? { ...x.layout, items: x.layout.items.filter((it) => !(c.id === it.nodeId || findNode(c.children, it.nodeId))) } : x.layout,
                    }))}>✕</button>
                  </span>
                );
              })}
              {asmGroupRoot(g, bom.units).missing.map((m) => <span key={m} className="chip warn">missing source</span>)}
            </div>
          )}
          <AsmEditor key={g.id} group={root} splitKey="asmgroups" nos={nos} cat={cat} len={len}
            setGroup={(f) => setG(g.id, (x) => ({ ...x, layout: f(asmGroupRoot(x, bom.units).root).layout ?? null }))}
            checkTab={(sel) => (set.link ? <CheckPanel g={g} units={bom.units} all={set.groups} cat={cat} nos={nos} sel={sel} /> : <p className="muted hintline">Link a saved BOM version to check quantities.</p>)}
            onAddGroup={() => setDlg("new")} />
        </>
      ) : (
        <section className="pane"><div className="empty-state">
          <h3>No assembly groups yet</h3>
          <p>{set.link ? "Create a group from BOM groups / sub-assemblies of the linked BOM (e.g. PDU.01 = B1 + B2 on one 4U RMU), from master parts, or from a template." : "Link a saved project BOM version first; its groups and sub-assemblies compose the assembly groups and their quantities are checked against the layouts."}</p>
          <div className="toolbar">
            {!set.link && <button type="button" className="btn-primary" onClick={() => setDlg("link")}>Link a BOM version…</button>}
            <button type="button" className={set.link ? "btn-primary" : ""} onClick={() => setDlg("new")}>+ New group…</button>
            {legacy.length > 0 && (
              <button type="button" onClick={() => setSet((s) => ({ ...s, groups: [...s.groups, ...legacy.map((n) => newAsmGroup(n.alias || n.name || n.tags[0] || "GROUP", { sources: [n.id], layout: n.layout ?? null }))] }))}
                title="Earlier layouts were stored on the BOM groups themselves">Convert {legacy.length} BOM-group layout(s)</button>
            )}
          </div>
        </div></section>
      )}
      {dlg === "link" && <LinkDialog current={set.link} onClose={() => setDlg(null)} onDone={(l) => (setSet((s) => ({ ...s, link: l })), setDlg(null))} />}
      {(dlg === "new" || dlg === "add") && (
        <NewGroupDialog title={dlg === "new" ? "New assembly group" : `Add to ${g?.name}`} existing={dlg === "add"} units={bom.units} cat={cat} templates={tpls}
          onClose={() => setDlg(null)}
          onDone={async (r) => {
            setDlg(null);
            const { extras, tplLayout } = await build(r);
            if (dlg === "add" && g) {
              setG(g.id, (x) => ({ ...x, sources: [...x.sources, ...r.sources.filter((s) => !x.sources.includes(s))], extras: [...x.extras, ...extras] }));
              return;
            }
            const ng = newAsmGroup(r.name, { sources: r.sources, extras, layout: tplLayout ?? emptyAsmLayout(r.mount, r.rackUnits) });
            setSet((s) => ({ ...s, groups: [...s.groups, ng] }));
            setCur(ng.id);
            refreshTpls();
            ui.toast(`Group “${ng.name}” created — save the project BOM to keep it`);
          }} />
      )}
      {dlg === "save" && root && <SaveTemplateDialog root={root} defaultKind={root.layout?.mount === "rack" ? "RU" : "DIN"} onClose={() => (setDlg(null), refreshTpls())} />}
    </>
  );
}
