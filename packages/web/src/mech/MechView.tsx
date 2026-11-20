import {
  ROLE_SIGN, asmDescOf, asmGroupRoot, emptyAsmLayout, emptyAsmSet, asmSize, computeOverlay, deviceIds, findNode, nodeIdentity, nodeRole, groupNode, importUnit, itemNumbers, latest, newLayoutDoc, refUnit, refreshSnaps, unitLabelOf, updateNode, verLabel, walk,
  type AsmTemplate, type BomDoc, type BomNode, type MechLayoutDoc, type MechRef, type TagDisplay,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type AsmItem, type Versioned } from "../api";
import { ASM_KEY, EMPTY_LIB as EMPTY_ASM_LIB, PROJ_KEY, STAGE_COLUMN, asmCanon, docCanon } from "../bom/BomView";
import { useCatalog } from "../bom/shared";
import { fneLayoutStore, rackLayoutStore, useAsmDraft, useBomDoc } from "../bom/store";
import { stableJson } from "../snapshots";
import { Modal, Seg, useLocal, useUi } from "../ui";
import { VersionBar, type VersionBarHandle } from "../VersionBar";
import { useMfrAliases } from "../bom/aliases";
import { AsmDescModal, ImportAsmDesc, pyDesc } from "../bom/PnFormat";
import { AsmEditor } from "./AsmEditor";
import { AsmGroups, useLinkedBom } from "./AsmGroups";
import { cloneLinked, masterBatch, templateCopy } from "./asmBuild";
import { NewGroupDialog } from "./NewGroupDialog";
import { TemplateLib } from "./TemplateLib";
import { MECH_SETTINGS_DEFAULT, TagBubbles, useLen, useMechSettings, type DevCtx, type MechSettings } from "./common";
import { prefixFinder, useProjectLayouts } from "../bom/mechPlaced";
import { FneTab } from "./FneTab";
import { RackTab } from "./RackTab";

type Tab = "assemblies" | "racks" | "fne";
type Kind = "rack" | "fne";
const LAYOUT_KEY: Record<Kind, string> = { rack: "fpl.snap.mechrack", fne: "fpl.snap.mechfne" };
const EMPTY_LIB = JSON.stringify({ id: null, loaded: null, pending: { major: 1, minor: 1 }, savedHash: null });
const storeOf = (k: Kind) => (k === "rack" ? rackLayoutStore : fneLayoutStore);
const apiOf = (k: Kind) => (k === "rack" ? api.mechRacks : api.mechFnes);

/** The referenced saved project BOM version (latest when the reference follows it). */
function useRefDoc(ref: MechRef | null, nonce: number) {
  const [state, setState] = useState<{ doc: BomDoc | null; ver: string; err: string; key: string }>({ doc: null, ver: "", err: "", key: "" });
  const key = ref ? `${ref.projectId}|${ref.major ?? "L"}|${ref.minor ?? ""}|${nonce}` : "";
  useEffect(() => {
    if (!ref) return setState({ doc: null, ver: "", err: "", key: "" });
    let live = true;
    (async () => {
      try {
        let v = ref.major != null && ref.minor != null ? { major: ref.major, minor: ref.minor } : null;
        if (!v) {
          const p = await api.bomProjects.get(ref.projectId);
          const l = latest(p.versions);
          if (!l) throw new Error("The referenced project has no saved versions");
          v = { major: l.major, minor: l.minor };
        }
        const r = await api.bomProjects.getVersion(ref.projectId, v.major, v.minor);
        if (live) setState({ doc: r.data as BomDoc, ver: verLabel(v), err: "", key });
      } catch (e) {
        if (live) setState({ doc: null, ver: "", err: errMsg(e), key });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Mechanical Design: assembly layouts (DIN-rail, terminal-block, rack-mounted), rack elevations and FNE back panels. */
export function MechView({ active }: { active: boolean }) {
  const ui = useUi();
  const cat = useCatalog(active);
  const [pref, setPref] = useLocal<{ tab: Tab; src: "project" | "layout" | "template"; group: string }>("fpl.mech.view", { tab: "racks", src: "project", group: "" });
  const [doc, setDoc] = useBomDoc();
  const [draft, setDraft] = useAsmDraft();
  const [rackDoc, setRackDoc] = rackLayoutStore.use();
  const [fneDoc, setFneDoc] = fneLayoutStore.use();
  const len = useLen();
  const [tpls, setTpls] = useState<AsmItem[]>([]);
  const [tplCur, setTplCur] = useState<string | null>(null);
  const [barKey, setBarKey] = useState({ rack: 0, fne: 0 });
  const [dlg, setDlg] = useState<{ kind: Kind; mode: "new" | "ref" } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [asmBarKey, setAsmBarKey] = useState(0);
  const [layNew, setLayNew] = useState(false);
  const asmBar = useRef<VersionBarHandle>(null);
  const refreshTpls = useCallback(() => api.bomAssemblies.list().then(setTpls).catch(() => {}), []);
  useEffect(() => {
    if (active) refreshTpls();
  }, [active, refreshTpls]);

  const tab = pref.tab;
  const kind: Kind | null = tab === "racks" ? "rack" : tab === "fne" ? "fne" : null;
  const lay = kind === "rack" ? rackDoc : kind === "fne" ? fneDoc : null;
  const setLay = kind === "rack" ? setRackDoc : setFneDoc;
  const ref = useRefDoc(lay?.ref ?? null, nonce);
  const proj = useProjectLayouts(active);
  // A layout that follows the latest version of the project open in Parts & BOM uses that open BOM (live prefixes and edits).
  const live = !!lay?.ref && lay.ref.major == null && proj.projectId === lay.ref.projectId;
  const bomUnits = useMemo(() => (live ? doc.units : ref.doc?.units ?? []), [live, doc.units, ref.doc]);
  const bomUnit = useMemo(() => (bomUnits.length ? refUnit(bomUnits, lay?.ref ?? null) : null), [bomUnits, lay?.ref]);
  const dc = useMemo<DevCtx | undefined>(() => {
    if (!lay?.ref || !bomUnits.length) return undefined;
    const prefixOf = prefixFinder(bomUnits, cat.ctx, cat.smap);
    const nos = itemNumbers(bomUnits);
    const others = proj.layouts.filter((l) => l.doc !== lay && l.doc.unit.id !== lay.unit.id);
    const name = proj.layouts.find((l) => l.doc === lay)?.name ?? (lay.unit.name || "this layout");
    return {
      entries: deviceIds([...others, { name, doc: lay }], prefixOf),
      prefixOf,
      signOf: (id) => {
        const hit = findNode(bomUnits, id);
        return hit ? ROLE_SIGN[nodeRole(hit.node, hit.parents.length)] : "-";
      },
      itemNo: (id) => nos.get(id) ?? "",
      pnOf: (id) => {
        const b = findNode(bomUnits, id)?.node;
        return !b ? "" : b.kind === "part" ? nodeIdentity(b, cat.ctx).partNumber : b.alias || b.name || "";
      },
      editPrefix: live
        ? async (id) => {
            const hit = findNode(doc.units, id);
            if (!hit) return;
            const v = await ui.prompt("Prefix of this BOM line (empty = no prefix). The project BOM is updated; save it in Parts & BOM.", hit.node.noPrefix ? "" : hit.node.prefix ?? prefixOf(id), "Save");
            if (v == null) return;
            const t = v.trim();
            setDoc((d: BomDoc) => ({ ...d, units: updateNode(d.units, id, (n) => ({ ...n, prefix: t || undefined, noPrefix: t ? undefined : true })) }));
          }
        : null,
    };
  }, [lay, bomUnits, cat.ctx, cat.smap, proj.layouts, live, doc.units, ui, setDoc]);
  const ov = useMemo(() => (lay ? computeOverlay(lay.unit, bomUnit, cat.ctx) : undefined), [lay, bomUnit, cat.ctx]);
  const setLayUnit = (f: (u: BomNode) => BomNode) => setLay((d) => (d ? { ...d, unit: f(d.unit) } : d));
  const aliases = useMfrAliases();
  const [descDlg, setDescDlg] = useState<"edit" | "import" | null>(null);
  const [gear, setGear] = useState(false);
  const [ms, setMs] = useMechSettings();
  const descFmt = useMemo(() => pyDesc(lay?.desc?.fmt ?? null), [lay?.desc]);
  const descOf = useCallback((n: BomNode) => {
    if (n.kind === "group") return { left: n.alias || n.name || "assembly", right: "" };
    const id = nodeIdentity(n, cat.ctx);
    if (!id.part) return { left: `${id.manufacturer}\n${id.partNumber}`, right: "" };
    return asmDescOf(descFmt, id.part, cat.smap.get(id.part.subcategoryId ?? "")?.name ?? "", { aliases });
  }, [descFmt, cat.ctx, cat.smap, aliases]);

  // Assemblies: groups of the open project BOM, of the open rack / FNE layouts, or the template draft.
  const units = doc.units;
  const layUnits = useMemo(() => [rackDoc?.unit, fneDoc?.unit].filter((x): x is BomNode => !!x), [rackDoc, fneDoc]);
  const srcUnits = pref.src === "layout" ? layUnits : units;
  // BOM shown in the New-group popup of layout groups (reference of the open rack / FNE layout) and the project assembly groups' BOM.
  const layRef = rackDoc?.ref ?? fneDoc?.ref ?? null;
  const layBom = useLinkedBom(layRef ? { projectId: layRef.projectId, projectName: layRef.projectName, major: layRef.major, minor: layRef.minor } : null, doc.units, proj.projectId, nonce);
  const asmBom = useLinkedBom(doc.assemblies?.link ?? null, doc.units, proj.projectId, nonce);
  const nos = useMemo(() => itemNumbers(srcUnits), [srcUnits]);
  const groups = useMemo(() => {
    const l: { n: BomNode; unit: BomNode; label: string }[] = [];
    for (const u of srcUnits)
      walk(u.children, (n, ps) => {
        if (n.kind !== "group" || n.line || !(n.layout || n.children.some((c) => c.kind === "part" || c.line))) return;
        if (ps.some((p) => p.layout)) return;
        l.push({ n, unit: u, label: `${unitLabelOf(u)} · ${nos.get(n.id) ?? ""} ${n.alias || n.name || n.tags[0] || "(group)"}${n.tags[0] ? ` (-${n.tags[0]})` : ""}` });
      });
    return l;
  }, [srcUnits, nos]);
  const selGroup = groups.find((g) => g.n.id === pref.group) ?? groups[0];
  const setGroupUnit = (unitId: string) => (f: (u: BomNode) => BomNode) => {
    if (pref.src === "layout") {
      if (rackDoc?.unit.id === unitId) setRackDoc((d) => (d ? { ...d, unit: f(d.unit) } : d));
      else setFneDoc((d) => (d ? { ...d, unit: f(d.unit) } : d));
    } else setDoc((d: BomDoc) => ({ ...d, units: d.units.map((u) => (u.id === unitId ? f(u) : u)) }));
  };
  const saved = useMemo(() => (cat.loaded ? { ...doc, units: refreshSnaps(doc.units, cat.ctx) } : null), [doc, cat.loaded, cat.ctx]);

  const newLayout = (k: Kind, d: MechLayoutDoc) => {
    localStorage.setItem(LAYOUT_KEY[k], EMPTY_LIB);
    storeOf(k).set(d);
    setBarKey((b) => ({ ...b, [k]: b[k] + 1 }));
  };

  return (
    <section className="view simple mech" aria-label="Mechanical design">
      <header className="toolbar">
        <h1>Mechanical Design</h1>
        <Seg label="Section" value={tab} options={[["assemblies", "Assemblies"], ["racks", "Racks"], ["fne", "FNE"]]} onChange={(t) => setPref({ ...pref, tab: t })} />
        {active && kind && (
          <>
            <VersionBar<MechLayoutDoc>
              key={`${kind}${barKey[kind]}`}
              storageKey={LAYOUT_KEY[kind]}
              store={apiOf(kind)}
              noun={kind === "rack" ? "rack layout" : "FNE layout"}
              data={lay}
              canon={stableJson}
              defaultName={lay?.unit.tags[0] || lay?.unit.name || undefined}
              describe={(d) => ({ ref: d.ref ? `${d.ref.projectName} ${d.ref.unitLabel}` : "", lines: (() => { let n = 0; walk(d.unit.children, (x) => x.kind === "part" && n++); return n; })() })}
              restore={async (d) => storeOf(kind).set({ ...newLayoutDoc(kind, ""), ...d })}
            />
            <button type="button" onClick={() => setDlg({ kind, mode: "new" })} title="New layout: import the equipment of a project BOM unit (master parts), or start empty">New…</button>
          </>
        )}
        {active && tab === "assemblies" && pref.src === "project" && (
          <VersionBar<BomDoc> storageKey={PROJ_KEY} store={api.bomProjects} noun="project BOM" data={saved} canon={docCanon} defaultName={doc.project.name || undefined} restore={async (d) => setDoc(d)} metaColumn={STAGE_COLUMN} />
        )}
        {active && tab === "assemblies" && pref.src === "template" && (
          <VersionBar<AsmTemplate>
            key={`asm${asmBarKey}`}
            handle={asmBar}
            storageKey={ASM_KEY}
            store={api.bomAssemblies}
            noun="assembly template"
            data={draft}
            canon={asmCanon}
            createExtra={{ kind: draft.kind, code: "" }}
            restore={async (d) => setDraft({ ...{ kind: "RU" as const, root: groupNode("NEW ASSEMBLY"), notes: "" }, ...d })}
            onItems={() => refreshTpls()}
            onCurrent={(id) => setTplCur(id)}
          />
        )}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Units">
          <button type="button" aria-pressed={len.unit === "mm"} onClick={() => len.setUnit("mm")}>mm</button>
          <button type="button" aria-pressed={len.unit === "in"} onClick={() => len.setUnit("in")}>in</button>
        </div>
        <button type="button" className="btn-ghost gear" aria-label="Mechanical Design settings" title="Settings" onClick={() => setGear(true)}>⚙️</button>
      </header>
      {kind && lay && (
        <div className="toolbar sub refbar">
          <label className="ctl">Layout<input type="text" value={lay.unit.name} onChange={(e) => setLayUnit((u) => ({ ...u, name: e.target.value }))} style={{ width: 160 }} /></label>
          <span className="muted" style={{ fontSize: 12.5 }}>BOM reference:</span>
          {lay.ref ? (
            <b className={ref.err || (ref.doc && !bomUnit) ? "errtxt" : undefined} title={ref.err || undefined}>
              {lay.ref.projectName} {lay.ref.major != null ? `v${verLabel({ major: lay.ref.major, minor: lay.ref.minor ?? 1 })}` : `latest${ref.ver ? ` (v${ref.ver})` : ""}`}{ref.doc ? ` (${ref.doc.stage})` : ""} · {lay.ref.unitLabel}
              {ref.err && !live ? " — can't load" : (ref.doc || live) && !bomUnit ? " — unit not found" : ""}{live && <span className="chip info" style={{ marginLeft: 6 }} title="Uses the project BOM open in Parts & BOM (unsaved edits included)">live</span>}
            </b>
          ) : <span className="muted">none (device tags come from the layout lines)</span>}
          <button type="button" className="btn-ghost" onClick={() => setDlg({ kind: kind, mode: "ref" })}>{lay.ref ? "Change…" : "Set reference…"}</button>
          {lay.ref && <button type="button" className="btn-ghost" onClick={() => setNonce((n) => n + 1)} title="Reload the referenced project BOM">↻</button>}
          {lay.ref && <button type="button" className="btn-ghost" onClick={() => setLay((d) => (d ? { ...d, ref: null } : d))}>Clear</button>}
          <button type="button" className="btn-ghost" onClick={() => setDescDlg("edit")} title="Left / right text of each device (Assembly Descriptions); the middle shows the device tags">
            Descriptions: {lay.desc?.from ? `${lay.desc.from.name} v${verLabel(lay.desc.from)}` : lay.desc ? "layout copy" : "built-in"}…
          </button>
          <Seg<TagDisplay> label="Show on the drawing" value={lay.display ?? "both"} options={[["pn", "Part number"], ["tag", "Device tag"], ["both", "Both"]]} onChange={(v) => setLay((d) => (d ? { ...d, display: v } : d))} />
          {ov?.hasRef && (
            <span className="stlegend">
              <span className="stdot st-missing" /> {[...ov.status.values()].filter((x) => x === "missing").length} not on BOM
              <span className="stdot st-short" /> {[...ov.status.values()].filter((x) => x === "short").length + ov.notInLayout.length} short
            </span>
          )}
        </div>
      )}
      {tab === "assemblies" && (
        <div className="toolbar sub">
          <div className="seg" role="group" aria-label="Source">
            <button type="button" aria-pressed={pref.src === "project"} onClick={() => setPref({ ...pref, src: "project" })}>Project BOM groups</button>
            <button type="button" aria-pressed={pref.src === "layout"} onClick={() => setPref({ ...pref, src: "layout" })}>Rack / FNE layout groups</button>
            <button type="button" aria-pressed={pref.src === "template"} onClick={() => setPref({ ...pref, src: "template" })}>Template library</button>
          </div>
          {pref.src === "layout" && (
            <>
              <label className="ctl">Assembly
                <select value={selGroup?.n.id ?? ""} onChange={(e) => setPref({ ...pref, group: e.target.value })} style={{ maxWidth: 420 }}>
                  {groups.map((g) => {
                    const s = asmSize(g.n, cat.ctx);
                    return <option key={g.n.id} value={g.n.id}>{g.label}{g.n.layout ? ` · ${g.n.layout.mount === "rack" ? `${g.n.layout.rackUnits}U` : g.n.layout.mount === "rail" ? "rail group" : "DIN"}${s ? ` ${Math.round(s.w)}×${Math.round(s.h)}` : ""}` : ""}</option>;
                  })}
                </select>
              </label>
              <button type="button" onClick={() => setLayNew(true)} disabled={!layUnits.length}>+ New group…</button>
              <span className="muted" style={{ fontSize: 12 }}>Groups of the open rack and FNE layouts; save them with the layout version bars.</span>
            </>
          )}
          {pref.src === "template" && <span className="muted" style={{ fontSize: 12 }}>Pick a template in the library; save changes with the template version bar.</span>}
        </div>
      )}
      {cat.err ? (
        <section className="pane"><div className="empty-state"><h3>Can’t reach the server</h3><p>{cat.err}</p></div></section>
      ) : kind && !lay ? (
        <section className="pane"><div className="empty-state">
          <h3>No {kind === "rack" ? "rack" : "FNE"} layout open</h3>
          <p>Open a saved layout with the version bar, or start a new one: its equipment comes from the master parts (imported once from a project BOM unit, then edited freely); a saved project BOM version is referenced only to show device tags and flag differences.</p>
          <div className="toolbar"><button type="button" className="btn-primary" onClick={() => setDlg({ kind, mode: "new" })}>New {kind === "rack" ? "rack" : "FNE"} layout…</button></div>
        </div></section>
      ) : kind === "rack" && lay ? (
        <RackTab key={lay.unit.id} unit={lay.unit} setUnit={setLayUnit} cat={cat} ov={ov} bomUnit={bomUnit} display={lay.display ?? "both"} descOf={descOf} dc={dc} />
      ) : kind === "fne" && lay ? (
        <FneTab key={lay.unit.id} unit={lay.unit} setUnit={setLayUnit} cat={cat} len={len} ov={ov} bomUnit={bomUnit} display={lay.display ?? "both"} descOf={descOf} dc={dc} />
      ) : tab === "assemblies" && pref.src === "template" ? (
        <TemplateLib cat={cat} len={len} tpls={tpls} refreshTpls={refreshTpls} cur={tplCur} draft={draft} setDraft={setDraft}
          load={(id) => {
            const t = tpls.find((x) => x.id === id);
            const v = t && latest(t.versions);
            if (t && v) asmBar.current?.load(t.id, v);
          }}
          onNew={(folder) => {
            localStorage.setItem(ASM_KEY, EMPTY_ASM_LIB);
            setDraft(() => ({ kind: "RU", root: groupNode("NEW ASSEMBLY"), notes: "" }));
            setTplCur(null);
            setAsmBarKey((k) => k + 1);
            if (folder) ui.toast(`New template — after the first save, move it to ${folder} with the Folder field`);
          }} />
      ) : tab === "assemblies" && pref.src === "project" ? (
        <AsmGroups cat={cat} len={len} tpls={tpls} refreshTpls={refreshTpls} />
      ) : tab === "assemblies" && selGroup ? (
        <AsmEditor key={selGroup.n.id} splitKey="asmlayout" group={selGroup.n} setGroup={(f) => setGroupUnit(selGroup.unit.id)((u) => ({ ...u, children: updateNode(u.children, selGroup.n.id, f) }))} cat={cat} len={len} onAddGroup={() => setLayNew(true)} />
      ) : (
        <section className="pane"><div className="empty-state">
          <p>{layUnits.length ? "No groups with parts in the open layouts." : "Open a rack or FNE layout first (Racks / FNE sections)."}</p>
          {layUnits.length > 0 && <div className="toolbar"><button type="button" className="btn-primary" onClick={() => setLayNew(true)}>+ New group…</button></div>}
        </div></section>
      )}
      {layNew && (
        <NewGroupDialog title="New layout group" units={layBom.units} cat={cat} templates={tpls}
          asms={(doc.assemblies ?? emptyAsmSet()).groups.map((g) => ({ id: g.id, label: g.name, root: asmGroupRoot(g, asmBom.units).root }))}
          targets={[rackDoc && { id: rackDoc.unit.id, label: `Rack layout ${rackDoc.unit.name || unitLabelOf(rackDoc.unit)}` }, fneDoc && { id: fneDoc.unit.id, label: `FNE layout ${fneDoc.unit.name || unitLabelOf(fneDoc.unit)}` }].filter((x): x is { id: string; label: string } => !!x)}
          onClose={() => setLayNew(false)}
          onDone={async (r) => {
            setLayNew(false);
            const kids: BomNode[] = [];
            for (const id of r.sources) {
              const n = findNode(layBom.units, id)?.node;
              if (n) kids.push(cloneLinked(n));
            }
            let layout = null as BomNode["layout"];
            const only = r.sources.length + r.masters.length + r.templates.length + r.asms.length === 1;
            for (const id of r.asms) {
              const g = (doc.assemblies ?? emptyAsmSet()).groups.find((x) => x.id === id);
              if (!g) continue;
              const c = cloneLinked(asmGroupRoot(g, asmBom.units).root);
              if (only) layout = c.layout ?? null;
              kids.push(...(only ? c.children : [{ ...c, layout: null }]));
            }
            const mb = masterBatch(r.masters, cat);
            if (mb) kids.push(mb);
            for (const t of r.templates) {
              const c = await templateCopy(t).catch(() => null);
              if (!c) continue;
              if (only) {
                layout = c.root.layout ?? null;
                kids.push(...c.root.children);
              } else kids.push({ ...c.root, layout: null });
            }
            const g = groupNode(r.name, { children: kids, layout: layout ?? emptyAsmLayout(r.mount, r.rackUnits) });
            const add = (u: BomNode) => ({ ...u, children: [...u.children, g] });
            if (rackDoc?.unit.id === r.target) setRackDoc((d) => (d ? { ...d, unit: add(d.unit) } : d));
            else setFneDoc((d) => (d ? { ...d, unit: add(d.unit) } : d));
            setPref({ ...pref, group: g.id });
            ui.toast(`Group “${g.name}” added to the layout — save it with the layout version bar`);
          }} />
      )}
      {gear && (
        <Modal size="sm" onClose={() => setGear(false)} label="Mechanical Design settings">
          <div className="mh"><h3>⚙️ Mechanical Design settings</h3></div>
          <div className="mb">
            <label className="chk-l">
              <input type="checkbox" checked={ms.models} onChange={(e) => setMs({ models: e.target.checked })} /> Use 2D models
            </label>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>On: each device is drawn with its uploaded 2D views where available (unless the part's “Draw these 2D views in layouts” is off). Off: every device is drawn as a generic box, whatever the part settings. Applies to racks, FNEs and assemblies; saved in this browser.</p>
            <h4 style={{ margin: "8px 0 0" }}>Device tags (squares) and part-line balloons</h4>
            <div className="frow tight bubset">
              <label className="f">Outline<input type="color" value={ms.bubStroke} onChange={(e) => setMs({ bubStroke: e.target.value })} /></label>
              <label className="f">Fill<input type="color" value={ms.bubFill} onChange={(e) => setMs({ bubFill: e.target.value })} /></label>
              <label className="f">Text color<input type="color" value={ms.bubText} onChange={(e) => setMs({ bubText: e.target.value })} /></label>
              <label className="f">Weight
                <select value={ms.bubWeight} onChange={(e) => setMs({ bubWeight: e.target.value as MechSettings["bubWeight"] })}><option value="400">Regular</option><option value="600">Semibold</option><option value="700">Bold</option></select>
              </label>
              <label className="f">Font
                <select value={ms.bubFont} onChange={(e) => setMs({ bubFont: e.target.value as MechSettings["bubFont"] })}><option value="mono">Monospace</option><option value="ui">Sans-serif</option></select>
              </label>
              <label className="f">Size ×<input type="number" min={0.5} max={3} step={0.1} value={ms.bubScale} onChange={(e) => setMs({ bubScale: Math.max(0.5, Math.min(3, Number(e.target.value) || 1)) })} style={{ width: 64 }} /></label>
              <label className="chk-l" style={{ alignSelf: "flex-end" }}><input type="checkbox" checked={ms.bubItalic} onChange={(e) => setMs({ bubItalic: e.target.checked })} /> Italic</label>
            </div>
            <svg viewBox="0 0 220 34" width={330} height={51} className="mechsvg" style={{ margin: 0, background: "#eef1f4", borderRadius: 4 }} aria-label="Preview">
              <TagBubbles cx={110} cy={17} tags={["-SRV.01", "-SRV.02"]} maxW={210} size={11} />
            </svg>
            <div><button type="button" className="btn-ghost" onClick={() => setMs({ ...MECH_SETTINGS_DEFAULT, models: ms.models })}>Reset bubble style</button></div>
          </div>
          <div className="mf"><button type="button" className="btn-primary" onClick={() => setGear(false)}>Done</button></div>
        </Modal>
      )}
      {descDlg === "edit" && lay && (
        <AsmDescModal title={`Device descriptions of ${lay.unit.name || "this layout"}`} fmt={lay.desc?.fmt ?? null} src={{ parts: cat.parts, subcats: [...cat.smap.values()] }}
          onChange={(f) => setLay((d) => (d ? { ...d, desc: f ? { from: d.desc?.from ?? null, fmt: f } : null } : d))} onClose={() => setDescDlg(null)} onImport={() => setDescDlg("import")} />
      )}
      {descDlg === "import" && (
        <ImportAsmDesc onClose={() => setDescDlg("edit")} onPick={(from, fmt) => (setLay((d) => (d ? { ...d, desc: { from, fmt } } : d)), setDescDlg("edit"))} />
      )}
      {dlg && (
        <RefDialog
          kind={dlg.kind}
          mode={dlg.mode}
          current={dlg.mode === "ref" ? lay?.ref ?? null : null}
          onClose={() => setDlg(null)}
          onDone={(r, bom, name) => {
            const k = dlg.kind;
            setDlg(null);
            if (dlg.mode === "ref") return storeOf(k).set((d) => (d ? { ...d, ref: r } : d));
            const base = newLayoutDoc(k, name || (bom ? unitLabelOf(bom) : k === "rack" ? "RACK" : "FNE"));
            const unit = bom ? { ...importUnit(bom, k), name: name || bom.name || unitLabelOf(bom) } : base.unit;
            newLayout(k, { ...base, unit, ref: r });
            ui.toast(bom ? `Imported ${unitLabelOf(bom)} into a new layout — save it with the version bar` : "New empty layout — save it with the version bar");
          }}
        />
      )}
    </section>
  );
}

/** Pick a saved project BOM (version or latest) and one of its units: the reference of a layout, and for a new layout the unit to import. */
function RefDialog({ kind, mode, current, onClose, onDone }: {
  kind: Kind; mode: "new" | "ref"; current: MechRef | null; onClose: () => void;
  onDone: (ref: MechRef | null, bomUnit: BomNode | null, name: string) => void;
}) {
  const [projects, setProjects] = useState<Versioned[]>([]);
  const [pid, setPid] = useState(current?.projectId ?? "");
  const [ver, setVer] = useState(current ? (current.major != null ? `${current.major}.${current.minor}` : "latest") : "latest");
  const [data, setData] = useState<BomDoc | null>(null);
  const [uid, setUid] = useState(current?.unitId ?? "");
  const [name, setName] = useState("");
  const [imp, setImp] = useState(true);
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
  useEffect(() => {
    setData(null);
    if (!proj) return;
    const v = ver === "latest" ? latest(proj.versions) : proj.versions.find((x) => `${x.major}.${x.minor}` === ver);
    if (!v) return;
    api.bomProjects.getVersion(proj.id, v.major, v.minor).then((r) => {
      const d = r.data as BomDoc;
      setData(d);
      setUid((u) => (d.units.some((x) => x.id === u) ? u : (d.units.find((x) => (kind === "fne" ? /FNE|PANEL/i : /RACK/i).test(x.tags[0] ?? x.name)) ?? d.units[0])?.id ?? ""));
    }).catch((e) => setErr(errMsg(e)));
  }, [proj, ver, kind]);
  const unit = data?.units.find((u) => u.id === uid) ?? null;
  const ref: MechRef | null = proj && unit ? {
    projectId: proj.id, projectName: proj.name,
    major: ver === "latest" ? null : Number(ver.split(".")[0]), minor: ver === "latest" ? null : Number(ver.split(".")[1]),
    unitId: unit.id, unitLabel: unitLabelOf(unit),
  } : null;
  return (
    <Modal size="sm" onClose={onClose} label="Project BOM reference">
      <div className="mh"><h3>{mode === "new" ? `New ${kind === "rack" ? "rack" : "FNE"} layout` : "BOM reference"}</h3></div>
      <div className="mb">
        {mode === "new" && <label className="f">Layout name<input type="text" value={name} placeholder={unit ? unitLabelOf(unit) : ""} onChange={(e) => setName(e.target.value)} /></label>}
        <label className="f">Saved project BOM
          <select value={pid} onChange={(e) => setPid(e.target.value)}>
            {!projects.length && <option value="">(no saved project BOMs)</option>}
            {projects.map((p) => {
              const l = latest(p.versions);
              return <option key={p.id} value={p.id}>{p.name}{l?.meta?.stage ? ` (${String(l.meta.stage)})` : ""}</option>;
            })}
          </select>
        </label>
        <label className="f">Version
          <select value={ver} onChange={(e) => setVer(e.target.value)}>
            <option value="latest">Latest (follows new saves)</option>
            {proj?.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor).map((v) => <option key={`${v.major}.${v.minor}`} value={`${v.major}.${v.minor}`}>v{verLabel(v)}{v.meta?.stage ? ` (${String(v.meta.stage)})` : ""}{v.notes ? ` — ${v.notes.slice(0, 40)}` : ""}</option>)}
          </select>
        </label>
        <label className="f">Unit
          <select value={uid} onChange={(e) => setUid(e.target.value)}>
            {data?.units.map((u) => <option key={u.id} value={u.id}>{unitLabelOf(u)}{u.qty > 1 ? ` (× ${u.qty})` : ""}{u.rack ? " · rack layout" : ""}{u.fne ? " · FNE layout" : ""}</option>)}
          </select>
        </label>
        {mode === "new" && (
          <label className="chk-l"><input type="checkbox" checked={imp} onChange={(e) => setImp(e.target.checked)} /> Import the unit's equipment (and its existing {kind === "rack" ? "rack" : "FNE"} layout) into the new layout</label>
        )}
        {err && <p className="errtxt" style={{ margin: 0 }}>{err}</p>}
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The layout keeps its own equipment (master parts). The project BOM only supplies device tags and quantities: lines no longer on it show red, fewer placed than on the BOM show yellow.</p>
      </div>
      <div className="mf">
        {mode === "new" && <button type="button" onClick={() => onDone(null, null, name)}>Empty, no reference</button>}
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!ref} onClick={() => onDone(ref, mode === "new" && imp ? unit : null, name)}>{mode === "new" ? "Create" : "Set reference"}</button>
      </div>
    </Modal>
  );
}
