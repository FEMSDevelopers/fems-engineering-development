import { cloneNode, emptyBomDoc, latest, verLabel, type AsmTemplate, type BomDoc, type BomNode } from "@fpl/core";
import { useEffect, useState } from "react";
import { api, errMsg, type AsmItem, type Versioned } from "../api";
import { Modal, useUi } from "../ui";

type LoadTpl = (id: string) => Promise<{ data: AsmTemplate; major: number; minor: number; name: string } | null>;

/** New project BOM: blank, a copy of a saved project BOM version, or built from rack / FNE / panel templates. */
export function NewProject({ tpls, loadTemplate, dirty, onClose, onCreate }: { tpls: AsmItem[]; loadTemplate: LoadTpl; dirty: boolean; onClose: () => void; onCreate: (d: BomDoc) => void }) {
  const ui = useUi();
  const [mode, setMode] = useState<"blank" | "copy" | "tpl">("tpl");
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<Versioned[]>([]);
  const [src, setSrc] = useState("");
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.bomProjects.list().then(setProjects).catch(() => {});
  }, []);
  const unitTpls = tpls.filter((t) => ["RACK", "FNE", "PANEL"].includes(t.kind));
  const otherTpls = tpls.filter((t) => !["RACK", "FNE", "PANEL"].includes(t.kind));
  const go = async () => {
    if (dirty && !(await ui.confirm("Replace the open project BOM? Unsaved changes are lost.", "Replace"))) return;
    setBusy(true);
    try {
      const d = emptyBomDoc();
      d.project.name = name.trim();
      if (mode === "copy") {
        const [id, ma, mi] = src.split("|");
        if (!id) return ui.toast("Pick a saved project BOM");
        const v = await api.bomProjects.getVersion(id, +ma, +mi);
        const s = v.data as BomDoc;
        // Fresh node ids: the copy is a new project, not a version of the source.
        Object.assign(d, s, { units: s.units.map((u) => cloneNode(u)), project: { ...s.project, name: name.trim() || `${s.project.name} (copy)` } });
      } else if (mode === "tpl") {
        const units: BomNode[] = [];
        for (const [id, count] of Object.entries(picked)) {
          const t = await loadTemplate(id);
          if (!t) continue;
          for (let i = 0; i < count; i++) {
            const root = cloneNode(t.data.root);
            root.from = { assemblyId: id, name: t.name, major: t.major, minor: t.minor };
            root.role = "loc";
            if (["RACK", "FNE", "PANEL"].includes(t.data.kind)) units.push(root);
            else units.push({ ...root, kind: "group", name: root.name, tags: [] });
          }
        }
        d.units = units;
      }
      onCreate(d);
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const tplRow = (t: AsmItem) => {
    const v = latest(t.versions);
    return (
      <tr key={t.id}>
        <td><input type="number" min={0} max={50} aria-label={`Count of ${t.name}`} value={picked[t.id] ?? 0} style={{ width: 56 }} onChange={(e) => setPicked({ ...picked, [t.id]: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} /></td>
        <td>{t.code && <span className="mono">{t.code} · </span>}{t.name}</td>
        <td className="muted">{t.kind}</td>
        <td className="mono muted">{v ? `v${verLabel(v)}` : "not saved"}</td>
      </tr>
    );
  };
  return (
    <Modal onClose={onClose} label="New project BOM">
      <div className="mh"><h3>New project BOM</h3><span className="muted" style={{ fontSize: 12.5 }}>The next save creates a new project (v1.001).</span></div>
      <div className="mb">
        <label className="f" style={{ maxWidth: 380 }}>Project name<input type="text" value={name} autoFocus placeholder="Sungrow Librillo" onChange={(e) => setName(e.target.value)} /></label>
        <div className="seg" role="group" aria-label="Start from">
          <button type="button" aria-pressed={mode === "tpl"} onClick={() => setMode("tpl")}>From templates</button>
          <button type="button" aria-pressed={mode === "copy"} onClick={() => setMode("copy")}>Copy of a saved project BOM</button>
          <button type="button" aria-pressed={mode === "blank"} onClick={() => setMode("blank")}>Blank</button>
        </div>
        {mode === "tpl" && (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Set how many of each template to start with. Racks, FNEs and wall-mount panels become units; other assemblies become top-level groups you can move into units.</p>
            <table className="mini wide">
              <thead><tr><th>Count</th><th>Template</th><th>Kind</th><th>Latest</th></tr></thead>
              <tbody>
                {unitTpls.map(tplRow)}
                {otherTpls.map(tplRow)}
                {!tpls.length && <tr><td colSpan={4} className="muted">No templates saved yet (Parts &amp; BOM → Assemblies, or “Save as template…” on a project group).</td></tr>}
              </tbody>
            </table>
          </>
        )}
        {mode === "copy" && (
          <label className="f">Saved project BOM version
            <select value={src} onChange={(e) => setSrc(e.target.value)}>
              <option value="">— pick —</option>
              {projects.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.versions.map((v) => <option key={`${v.major}.${v.minor}`} value={`${p.id}|${v.major}|${v.minor}`}>{p.name} v{verLabel(v)}{v.meta?.stage ? ` (${String(v.meta.stage)})` : ""}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || (mode === "copy" && !src) || (mode === "tpl" && !Object.values(picked).some((n) => n > 0))} onClick={go}>Create</button>
      </div>
    </Modal>
  );
}
