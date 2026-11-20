import {
  ASM_KINDS, STAGES, cloneNode, syncUndefinedUnits, undefinedMechParts, unitLabelOf, emptyBomDoc, explode, groupNode, latest, refreshSnaps, stamp, tagIssues, unlinkedLines,
  type AsmKind, type AsmTemplate, type BomDoc, type BomNode,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type AsmItem } from "../api";
import { stableJson } from "../snapshots";
import { Modal, Seg, useLocal, useUi } from "../ui";
import { VersionBar, type VersionBarHandle } from "../VersionBar";
import { CompareTab } from "./CompareTab";
import { EquipImport } from "./EquipImport";
import { LoadsTab } from "./LoadsTab";
import { OutputsTab } from "./OutputsTab";
import { PartsTab } from "./PartsTab";
import { fmtN, useCatalog, type Catalog } from "./shared";
import { NewProject } from "./NewProject";
import { useMechPlaced } from "./mechPlaced";
import { useAsmDraft, useBomDoc } from "./store";
import { TreeEditor } from "./TreeEditor";
import { TplTree } from "./TplTree";

type Tab = "parts" | "assemblies" | "project" | "loads" | "compare" | "outputs";
export const PROJ_KEY = "fpl.snap.bomproject";
export const STAGE_COLUMN = { key: "stage", label: "Stage", options: STAGES };
export const ASM_KEY = "fpl.snap.bomasm";
export const EMPTY_LIB = JSON.stringify({ id: null, loaded: null, pending: { major: 1, minor: 1 }, savedHash: null });

export const docCanon = (d: BomDoc) => stableJson(d);
export const asmCanon = (d: AsmTemplate) => stableJson(d);
type LoadTpl = (id: string, ver?: { major: number; minor: number }) => Promise<{ data: AsmTemplate; major: number; minor: number; name: string } | null>;
const emptyTemplate = (kind: AsmKind = "RU"): AsmTemplate => ({ kind, root: groupNode("NEW ASSEMBLY", { tags: [] }), notes: "" });

/** Parts & BOM module: master parts, assembly templates, project BOM versions, loads, comparison and outputs. */
export function BomView({ active }: { active: boolean }) {
  const ui = useUi();
  const cat = useCatalog(active);
  const [pref, setPref] = useLocal<{ tab: Tab }>("fpl.bom.view", { tab: "parts" });
  const tab = pref.tab;
  const [doc, setDoc] = useBomDoc();
  const [tpls, setTpls] = useState<AsmItem[]>([]);
  const [barKey, setBarKey] = useState(0);
  const [saveTpl, setSaveTpl] = useState<BomNode | null>(null);
  const [newProj, setNewProj] = useState(false);
  const refreshTpls = useCallback(() => api.bomAssemblies.list().then(setTpls).catch(() => {}), []);
  useEffect(() => {
    if (active) refreshTpls();
  }, [active, refreshTpls]);

  const loadTemplate = useCallback(
    async (id: string, ver?: { major: number; minor: number }) => {
      const list = await api.bomAssemblies.list();
      setTpls(list);
      const t = list.find((x) => x.id === id);
      const v = t && (ver && t.versions.find((x) => x.major === ver.major && x.minor === ver.minor) ? ver : latest(t.versions));
      if (!t || !v) return null;
      const full = await api.bomAssemblies.getVersion(id, v.major, v.minor);
      return { data: full.data as AsmTemplate, major: v.major, minor: v.minor, name: t.name };
    },
    [],
  );

  const setUnits = (units: BomNode[]) => setDoc({ ...doc, units });
  const updUnits = useCallback((f: (u: BomNode[]) => BomNode[]) => setDoc((d: BomDoc) => {
    const units = f(d.units);
    return units === d.units ? d : { ...d, units };
  }), [setDoc]);
  const setShortlist = (shortlist: string[]) => setDoc({ ...doc, shortlist });
  // Saved versions carry a snapshot of each part's identity (so later catalog edits don't rewrite history).
  const saved = useMemo(() => (cat.loaded ? { ...doc, units: refreshSnaps(doc.units, cat.ctx) } : null), [doc, cat.loaded, cat.ctx]);
  const counts = useMemo(() => {
    const lines = explode(doc.units, cat.ctx).filter((l) => l.kind === "part");
    return { lines: lines.length, tagIssues: Object.keys(tagIssues(doc.units)).length, unlinked: unlinkedLines(doc.units, cat.ctx).length };
  }, [doc.units, cat.ctx]);
  const projectTabs = tab === "project" || tab === "loads" || tab === "outputs";
  // Project BOM: unit filter bubbles and Import equipment list sit on the project bar (right of Stage); the sort /
  // filter rules of the builder table get the row below it.
  const [onlyUnit, setOnlyUnit] = useLocal<string>("fpl.bom.onlyUnit", "");
  const shownUnit = doc.units.some((u) => u.id === onlyUnit) ? onlyUnit : "";
  const [importing, setImporting] = useState(false);
  const [rulesSlot, setRulesSlot] = useState<HTMLDivElement | null>(null);

  return (
    <section className="view simple bom" aria-label="Parts and BOM">
      <header className="toolbar">
        <h1>Parts &amp; BOM</h1>
        <Seg
          label="Section"
          value={tab}
          options={[
            ["parts", `Parts (${cat.parts.length})`],
            ["assemblies", `Assemblies (${tpls.length})`],
            ["project", "Project BOM"],
            ["loads", "Loads"],
            ["compare", "Compare"],
            ["outputs", "Outputs"],
          ]}
          onChange={(t) => setPref({ tab: t })}
        />
        {projectTabs && active && (
          <>
            <VersionBar<BomDoc>
              key={barKey}
              storageKey={PROJ_KEY}
              store={api.bomProjects}
              noun="project BOM"
              data={saved}
              canon={docCanon}
              defaultName={doc.project.name || undefined}
              describe={(d) => ({ stage: d.stage, units: d.units.length, lines: explode(d.units).filter((l) => l.kind === "part").length })}
              restore={async (d) => setDoc({ ...emptyBomDoc(), ...d })}
              metaColumn={STAGE_COLUMN}
            />
            <button type="button" title="Start a new project BOM: blank, a copy of a saved project, or from rack / FNE templates (the next save creates a new project)" onClick={() => setNewProj(true)}>New…</button>
          </>
        )}
      </header>
      {projectTabs && (
        <div className="toolbar sub projbar">
          <b className="ptitle">{doc.project.name || "Untitled project"} ({doc.stage})</b>
          <label className="ctl">Project<input type="text" value={doc.project.name} placeholder="Sungrow Librillo" onChange={(e) => setDoc({ ...doc, project: { ...doc.project, name: e.target.value } })} style={{ width: 200 }} /></label>
          <label className="ctl">No.<input type="text" value={doc.project.number} onChange={(e) => setDoc({ ...doc, project: { ...doc.project, number: e.target.value } })} style={{ width: 90 }} /></label>
          <label className="ctl">Client<input type="text" value={doc.project.client} onChange={(e) => setDoc({ ...doc, project: { ...doc.project, client: e.target.value } })} style={{ width: 140 }} /></label>
          <label className="ctl">Stage
            <select value={doc.stage} onChange={(e) => setDoc({ ...doc, stage: e.target.value })}>
              {[...new Set([...STAGES, doc.stage])].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <span className="muted" style={{ fontSize: 12.5 }}>{doc.units.length} unit(s) · {counts.lines} part lines</span>
          {counts.tagIssues > 0 && <span className="chip err" title="Duplicate device tags or tag count ≠ quantity">{counts.tagIssues} tag issue(s)</span>}
          {counts.unlinked > 0 && <span className="chip" title="Lines not linked to a master part (imported or deleted from the catalog)">{counts.unlinked} unlinked</span>}
          {tab === "project" && (
            <div className="unitbubbles" role="group" aria-label="Units shown">
              {/* Show all units, or one unit only (its lines alone are listed). */}
              <button type="button" className="bubble" aria-pressed={!shownUnit} onClick={() => setOnlyUnit("")}>Show all units ({doc.units.length})</button>
              {doc.units.map((u) => (
                <button key={u.id} type="button" className="bubble" aria-pressed={shownUnit === u.id} onClick={() => setOnlyUnit(u.id)}
                  title={`${u.tags.length > 1 ? `${u.tags.length} × ` : ""}${u.tags.map((t) => `+${t}`).join(", ")}${u.name ? ` ${u.name}` : ""}\nShow only this unit`}>
                  {u.tags[0] ? `+${unitLabelOf(u)}` : unitLabelOf(u)}{u.tags.length > 1 ? ` ×${u.tags.length}` : ""}{u.name && u.tags[0] ? <span className="muted"> {u.name}</span> : null}
                </button>
              ))}
              <button type="button" onClick={() => setImporting(true)}>Import equipment list…</button>
            </div>
          )}
        </div>
      )}
      {tab === "project" && <div className="bomrulesslot" ref={setRulesSlot} />}
      {cat.err ? (
        <section className="pane"><div className="empty-state"><h3>Can’t reach the server</h3><p>{cat.err}</p><button type="button" onClick={cat.refresh}>Retry</button></div></section>
      ) : tab === "parts" ? (
        <PartsTab cat={cat} shortlist={doc.shortlist} setShortlist={setShortlist} />
      ) : tab === "assemblies" ? (
        <AssembliesTab active={active} cat={cat} tpls={tpls} refreshTpls={refreshTpls} loadTemplate={loadTemplate} shortlist={doc.shortlist} setShortlist={setShortlist} onSaveAsTemplate={setSaveTpl} />
      ) : tab === "project" ? (
        <ProjectTab onlyUnit={shownUnit} importing={importing} setImporting={setImporting} rulesSlot={rulesSlot} cat={cat} doc={doc} setUnits={setUnits} updUnits={updUnits} shortlist={doc.shortlist} setShortlist={setShortlist} tpls={tpls} loadTemplate={loadTemplate} onSaveAsTemplate={setSaveTpl}
          onTemplateRename={async (id, name) => (await api.bomAssemblies.rename(id, name).catch((e) => ui.toast(errMsg(e))), refreshTpls())}
          onTemplateDelete={async (id) => (await api.bomAssemblies.remove(id).catch((e) => ui.toast(errMsg(e))), refreshTpls(), ui.toast("Template deleted"))} />
      ) : tab === "loads" ? (
        <LoadsTab cat={cat} doc={doc} setDoc={setDoc} />
      ) : tab === "compare" ? (
        <CompareTab cat={cat} current={doc} />
      ) : (
        <OutputsTab cat={cat} doc={doc} setDoc={setDoc} />
      )}
      {saveTpl && <SaveTemplate node={saveTpl} onClose={() => setSaveTpl(null)} onSaved={refreshTpls} />}
      {newProj && (
        <NewProject
          tpls={tpls}
          loadTemplate={loadTemplate}
          dirty={doc.units.length > 0}
          onClose={() => setNewProj(false)}
          onCreate={(d) => {
            localStorage.setItem(PROJ_KEY, EMPTY_LIB);
            setDoc(d);
            setBarKey((k) => k + 1);
            setNewProj(false);
            setPref({ tab: "project" });
          }}
        />
      )}
    </section>
  );
}

function ProjectTab(p: { onlyUnit: string; importing: boolean; setImporting: (v: boolean) => void; rulesSlot: HTMLElement | null; cat: Catalog; doc: BomDoc; setUnits: (u: BomNode[]) => void; updUnits: (f: (u: BomNode[]) => BomNode[]) => void; shortlist: string[]; setShortlist: (ids: string[]) => void; tpls: AsmItem[]; loadTemplate: LoadTpl; onSaveAsTemplate: (n: BomNode) => void; onTemplateRename: (id: string, name: string) => void; onTemplateDelete: (id: string) => void }) {
  const { importing, setImporting } = p;
  const mech = useMechPlaced(p.doc.units, true, p.cat.ctx, p.cat.smap);
  // Device tags of part lines come from Mechanical Design (device IDs of the layouts that reference this project).
  useEffect(() => {
    let changed = false;
    const fix = (ns: BomNode[]): BomNode[] => {
      let any = false;
      const out = ns.map((n) => {
        const children = fix(n.children);
        const t = n.kind === "part" ? mech.tags.get(n.id) : undefined;
        let x = children === n.children ? n : { ...n, children };
        if (t && (t.join("|") !== n.tags.join("|") || !n.mechTags)) x = { ...x, tags: t, mechTags: true };
        else if (!t && n.mechTags) x = { ...x, tags: [], mechTags: undefined };
        if (x !== n) any = true;
        return x;
      });
      if (any) changed = true;
      return any ? out : ns;
    };
    p.updUnits((units) => {
      changed = false;
      const next = fix(units);
      return changed ? next : units;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mech.tags]);
  // Parts placed in Mechanical Design that are not on the BOM: one "UNDEFINED MECHANICAL PARTS (<unit>)" unit per BOM unit.
  useEffect(() => {
    if (!p.cat.loaded) return;
    p.updUnits((units) => syncUndefinedUnits(units, undefinedMechParts(units, mech.layouts.map((l) => l.doc), p.doc.assemblies, p.cat.ctx), unitLabelOf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mech.layouts, p.doc.assemblies, p.doc.units, p.cat.loaded]);
  return (
    <div className="bomwrap">
      <TreeEditor
        rulesSlot={p.rulesSlot}
        onlyUnit={p.onlyUnit || null}
        nodes={p.doc.units}
        mech={mech.placed}
        mechLinks={mech.links}
        devs={mech}
        onChange={p.setUnits}
        cat={p.cat}
        shortlist={p.shortlist}
        setShortlist={p.setShortlist}
        mode="project"
        templates={p.tpls}
        loadTemplate={p.loadTemplate}
        onSaveAsTemplate={p.onSaveAsTemplate}
        onTemplateRename={p.onTemplateRename}
        onTemplateDelete={p.onTemplateDelete}
      />
      {importing && <EquipImport cat={p.cat} onClose={() => setImporting(false)} onImport={(units) => p.setUnits([...p.doc.units, ...units])} />}
    </div>
  );
}

function AssembliesTab(p: {
  active: boolean;
  cat: Catalog; tpls: AsmItem[]; refreshTpls: () => void; loadTemplate: LoadTpl;
  shortlist: string[]; setShortlist: (ids: string[]) => void; onSaveAsTemplate: (n: BomNode) => void;
}) {
  const ui = useUi();
  const [draft, setDraft] = useAsmDraft();
  const [cur, setCur] = useState<string | null>(null);
  const [view, setView] = useLocal<"bom" | "edit">("fpl.bom.tplview", "bom");
  const [barKey, setBarKey] = useState(0);
  const bar = useRef<VersionBarHandle>(null);
  const curItem = p.tpls.find((t) => t.id === cur);
  const setKind = async (kind: AsmKind) => {
    setDraft({ ...draft, kind });
    if (cur) await api.bomAssemblies.setMeta(cur, { kind }).catch((e) => ui.toast(errMsg(e)));
    p.refreshTpls();
  };
  return (
    <div className="asmwrap">
      <section className="pane asmlist">
        <div className="pane-head"><h3>Mechanical Design templates</h3><span className="muted">{p.tpls.length}</span></div>
        <TplTree tpls={p.tpls} cur={cur} onPick={(t) => {
          const v = latest(t.versions);
          if (v) bar.current?.load(t.id, v);
        }} />
      </section>
      <div className="asmmain">
        <div className="toolbar sub">
          <label className="ctl">Kind
            <select value={draft.kind} onChange={(e) => setKind(e.target.value as AsmKind)}>{ASM_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          {curItem && (
            <label className="ctl">Code
              <input type="text" className="mono" defaultValue={curItem.code} key={curItem.id + curItem.code} style={{ width: 140 }} placeholder="PDU-AC-230V" onBlur={async (e) => {
                if (e.target.value === curItem.code) return;
                await api.bomAssemblies.setMeta(curItem.id, { code: e.target.value.trim() });
                p.refreshTpls();
              }} />
            </label>
          )}
          {p.active && <VersionBar<AsmTemplate>
            key={barKey}
            handle={bar}
            storageKey={ASM_KEY}
            store={api.bomAssemblies}
            noun="assembly template"
            data={draft}
            canon={asmCanon}
            defaultName={draft.root.name || undefined}
            createExtra={{ kind: draft.kind, code: "" }}
            describe={(d) => ({ kind: d.kind, lines: explode([d.root]).filter((l) => l.kind === "part").length })}
            restore={async (d) => setDraft({ ...emptyTemplate(), ...d })}
            onItems={() => p.refreshTpls()}
            onCurrent={(id) => setCur(id)}
          />}
          <button type="button" onClick={async () => {
            const kind = draft.kind;
            if (!(await ui.confirm("Start a new, empty template? Unsaved changes to the current one are lost.", "New template"))) return;
            localStorage.setItem(ASM_KEY, EMPTY_LIB);
            setDraft(emptyTemplate(kind));
            setBarKey((k) => k + 1);
          }}>New</button>
          <span className="grow" />
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "bom"} onClick={() => setView("bom")}>Bill of material</button>
            <button type="button" aria-pressed={view === "edit"} onClick={() => setView("edit")}>Edit tree</button>
          </div>
        </div>
        {view === "bom" ? <TemplateBom draft={draft} item={curItem} cat={p.cat} /> : <TreeEditor
          nodes={[draft.root]}
          onChange={(n) => n[0] && setDraft({ ...draft, root: n[0] })}
          cat={p.cat}
          shortlist={p.shortlist}
          setShortlist={p.setShortlist}
          mode="template"
          templates={p.tpls}
          loadTemplate={p.loadTemplate}
          selfTemplateId={cur}
        />}
      </div>
    </div>
  );
}

/** Bill of material of a template (as saved with Mechanical Design: parts, quantities, mounting and size of its layout). */
function TemplateBom({ draft, item, cat }: { draft: AsmTemplate; item?: AsmItem; cat: Catalog }) {
  const lines = useMemo(() => explode([draft.root], cat.ctx).slice(1), [draft.root, cat.ctx]);
  const parts = lines.filter((l) => l.kind === "part");
  const l = draft.root.layout;
  const v = item ? latest(item.versions) : null;
  const ext = parts.reduce((s, x) => s + (x.partId && cat.pmap.get(x.partId)?.price != null ? cat.pmap.get(x.partId)!.price! * x.perUnit : 0), 0);
  return (
    <section className="pane tplbom">
      <div className="tplbomhead">
        <h3>{draft.root.name || "(template)"}</h3>
        <div className="kv">
          <span>Library</span><b>{item ? `${item.folder || "/"}${item.code ? ` · ${item.code}` : ""} · v${v ? `${v.major}.${String(v.minor).padStart(3, "0")}` : "—"}` : "unsaved"}</b>
          <span>Kind</span><b>{ASM_KINDS.find(([k]) => k === draft.kind)?.[1] ?? draft.kind}</b>
          <span>Mounting</span><b>{l ? (l.mount === "rack" ? `Rack-mounted ${l.rackUnits}U (front + rear rails)` : l.mount === "rail" ? "Rail group (no DIN rail)" : "DIN-rail assembly") : "no layout"}{l ? ` · ${Math.round(l.widthMm)} × ${Math.round(l.heightMm)}${l.depthMm ? ` × ${Math.round(l.depthMm)}` : ""} mm` : ""}</b>
          <span>Lines / devices</span><b>{parts.length} / {parts.reduce((s, x) => s + x.perUnit, 0)}{ext ? ` · ${fmtN(ext, 2)} (master unit prices)` : ""}</b>
        </div>
        {draft.notes && <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5, whiteSpace: "pre-wrap" }}>{draft.notes}</p>}
      </div>
      <div className="scroll">
        <table className="net">
          <thead><tr><th>No.</th><th>Manufacturer</th><th>Part number</th><th>Description</th><th className="num">Qty</th><th>Prefix</th><th>Subcategory</th></tr></thead>
          <tbody>
            {lines.map((x) => (
              <tr key={x.nodeId} className={x.kind === "group" ? "grp" : undefined}>
                <td className="mono">{x.itemNo}</td>
                <td>{x.manufacturer}</td>
                <td className="mono">{x.partNumber}</td>
                <td className="desc" title={x.description} style={{ paddingLeft: 6 + Math.max(0, x.depth - 1) * 12 }}>{x.kind === "group" ? <b>{x.description}</b> : x.description}</td>
                <td className="num">{x.kind === "part" ? fmtN(x.perUnit) : ""}</td>
                <td className="mono">{x.prefixCell}</td>
                <td>{x.partId ? cat.smap.get(cat.pmap.get(x.partId)?.subcategoryId ?? "")?.name ?? "" : ""}</td>
              </tr>
            ))}
            {!lines.length && <tr><td colSpan={7} className="muted">{item ? "This template has no lines." : "Pick a template on the left."}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Save a project group (rack, FNE, RU, DIN / terminal-block assembly…) as a reusable template, v1.001. */
function SaveTemplate({ node, onClose, onSaved }: { node: BomNode; onClose: () => void; onSaved: () => void }) {
  const ui = useUi();
  const guess: AsmKind = /RACK/i.test(node.tags[0] ?? "") ? "RACK" : /FNE/i.test(node.tags[0] ?? "") ? "FNE" : /TB|TERMINAL/i.test(node.name) ? "TB" : /PDU|DIN/i.test(node.name + (node.tags[0] ?? "")) ? "DIN" : "RU";
  const [name, setName] = useState(node.name || node.tags[0] || "Assembly");
  const [kind, setKind] = useState<AsmKind>(guess);
  const [code, setCode] = useState("");
  const [keepTags, setKeepTags] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const root = cloneNode(node);
      root.from = null;
      root.role = undefined;
      if (!keepTags) root.tags = [];
      const data: AsmTemplate = { kind, root, notes: "" };
      const t = await api.bomAssemblies.create({ name, kind, code });
      await api.bomAssemblies.saveVersion(t.id, 1, 1, { stamp: stamp(), data, meta: { kind, lines: explode([root]).filter((l) => l.kind === "part").length } });
      ui.toast(`Saved template “${name}” v1.001`);
      onSaved();
      onClose();
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="sm" onClose={onClose} label="Save as template">
      <div className="mh"><h3>Save as assembly template</h3></div>
      <div className="mb">
        <label className="f">Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="f">Kind<select value={kind} onChange={(e) => setKind(e.target.value as AsmKind)}>{ASM_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="f">Code (optional)<input type="text" className="mono" value={code} placeholder="PDU-AC-230V" onChange={(e) => setCode(e.target.value)} /></label>
        <label className="chk-l"><input type="checkbox" checked={keepTags} onChange={(e) => setKeepTags(e.target.checked)} /> Keep the group's own tag ({node.tags.join(", ") || "none"}); tags inside are always kept</label>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={go}>Save template</button>
      </div>
    </Modal>
  );
}
