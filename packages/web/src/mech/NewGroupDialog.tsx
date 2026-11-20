import { ASM_MOUNTS, findNode, itemNumbers, nodeIdentity, unitLabelOf, walk, type AsmMount, type BomNode } from "@fpl/core";
import { useMemo, useState } from "react";
import type { AsmItem } from "../api";
import type { Catalog } from "../bom/shared";
import { Modal } from "../ui";

export interface NewGroupResult {
  name: string;
  mount: AsmMount;
  rackUnits: number;
  /** BOM nodes (groups, sub-assemblies, part lines) of the BOM shown in the unit tabs. */
  sources: string[];
  /** Master parts with quantity. */
  masters: { partId: string; qty: number }[];
  /** Assembly templates (latest version). */
  templates: AsmItem[];
  /** Project assembly groups (layout mode). */
  asms: string[];
  /** Layout the group goes into (layout mode). */
  target: string;
}

/**
 * New group (or add to a group): the full BOM with one tab per unit (RACK.01, FNE.01 …) and a search on part number /
 * description; groups and sub-assemblies are picked as a whole, part lines one by one. Master parts and the template
 * library are tabs too; in layout mode the project assembly groups as well.
 */
export function NewGroupDialog({ title, units, cat, templates, asms, targets, existing, defaultName, onClose, onDone }: {
  title: string; units: BomNode[]; cat: Catalog; templates: AsmItem[];
  asms?: { id: string; label: string; root: BomNode }[]; targets?: { id: string; label: string }[];
  /** Adding to an existing group: no name / mounting. */
  existing?: boolean; defaultName?: string;
  onClose: () => void; onDone: (r: NewGroupResult) => void;
}) {
  const tabs = useMemo(() => [
    ...units.map((u) => ({ k: `u:${u.id}`, label: `${unitLabelOf(u)}${u.mechUndef ? "" : ""}` })),
    ...(asms ? [{ k: "asm", label: `Project assemblies (${asms.length})` }] : []),
    { k: "master", label: "Master parts" },
    { k: "tpl", label: `Template library (${templates.length})` },
  ], [units, asms, templates.length]);
  const [tab, setTab] = useState(tabs[0]?.k ?? "master");
  const [q, setQ] = useState("");
  const [src, setSrc] = useState<string[]>([]);
  const [masters, setMasters] = useState<Record<string, number>>({});
  const [tpls, setTpls] = useState<string[]>([]);
  const [asmSel, setAsmSel] = useState<string[]>([]);
  const [name, setName] = useState(defaultName ?? "");
  const [mount, setMount] = useState<AsmMount>("din");
  const [ru, setRu] = useState(4);
  const [target, setTarget] = useState(targets?.[0]?.id ?? "");
  const nos = useMemo(() => itemNumbers(units), [units]);
  const ql = q.trim().toLowerCase();
  const text = (n: BomNode) => {
    if (n.kind === "group") return `${nos.get(n.id) ?? ""} ${n.alias ?? ""} ${n.name} ${n.tags.join(" ")}`.toLowerCase();
    const id = nodeIdentity(n, cat.ctx);
    return `${nos.get(n.id) ?? ""} ${id.manufacturer} ${id.partNumber} ${id.description} ${n.tags.join(" ")}`.toLowerCase();
  };
  const unit = tab.startsWith("u:") ? units.find((u) => `u:${u.id}` === tab) : undefined;
  const rows = useMemo(() => {
    if (!unit) return [];
    const out: { n: BomNode; depth: number; anc: string[] }[] = [];
    walk(unit.children, (n, ps) => out.push({ n, depth: ps.length, anc: ps.map((p) => p.id) }));
    if (!ql) return out;
    const hit = new Set<string>();
    for (const r of out) if (text(r.n).includes(ql)) [r.n.id, ...r.anc].forEach((x) => hit.add(x));
    return out.filter((r) => hit.has(r.n.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit, ql, cat.ctx, nos]);
  const covered = (r: { n: BomNode; anc: string[] }) => r.anc.some((a) => src.includes(a));
  const toggle = (id: string) => setSrc((s) => {
    if (s.includes(id)) return s.filter((x) => x !== id);
    // Picking a group replaces picks inside it.
    const inner = new Set<string>();
    const n = findNode(units, id)?.node;
    if (n) walk(n.children, (c) => inner.add(c.id));
    return [...s.filter((x) => !inner.has(x)), id];
  });
  const parts = useMemo(() => cat.parts.filter((p) => !ql || `${p.manufacturer} ${p.partNumber} ${p.description}`.toLowerCase().includes(ql)).slice(0, 400), [cat.parts, ql]);
  const tplRows = templates.filter((t) => !ql || `${t.folder} ${t.code} ${t.name}`.toLowerCase().includes(ql));
  const asmRows = (asms ?? []).filter((a) => !ql || a.label.toLowerCase().includes(ql));
  const nSel = src.length + Object.keys(masters).length + tpls.length + asmSel.length;
  const picked = src.map((id) => findNode(units, id)?.node).filter((x): x is BomNode => !!x);
  const autoName = name.trim() || (picked.length ? picked.map((n) => n.tags[0] || n.alias || n.name || nos.get(n.id) || "").filter(Boolean).join(" + ") : "");
  return (
    <Modal onClose={onClose} label={title}>
      <div className="mh"><h3>{title}</h3><span className="grow" /><input type="search" placeholder="Search part number, description, group…" aria-label="Search the BOM" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 340 }} autoFocus /></div>
      <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
        {tabs.map((t) => {
          const cnt = t.k.startsWith("u:") ? src.filter((id) => units.find((u) => `u:${u.id}` === t.k && (u.id === id || findNode(u.children, id)))).length : t.k === "master" ? Object.keys(masters).length : t.k === "tpl" ? tpls.length : asmSel.length;
          return <button key={t.k} type="button" role="tab" className="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}>{t.label}{cnt ? ` · ${cnt}` : ""}</button>;
        })}
      </div>
      <div className="mb ngd">
        {unit && (
          <table className="mini wide ngtbl">
            <thead><tr><th aria-label="Pick" /><th>No.</th><th>Manufacturer</th><th>Part number</th><th className="c-desc">Description</th><th>Qty</th><th>Tags</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const n = r.n;
                const id = n.kind === "part" ? nodeIdentity(n, cat.ctx) : null;
                const inh = covered(r);
                return (
                  <tr key={n.id} className={`${n.kind === "group" ? "grp" : ""}${src.includes(n.id) || inh ? " picked" : ""}`} onClick={() => !inh && toggle(n.id)}>
                    <td><input type="checkbox" aria-label={`Pick ${n.kind === "group" ? n.name : id?.partNumber}`} checked={src.includes(n.id) || inh} disabled={inh} onChange={() => toggle(n.id)} onClick={(e) => e.stopPropagation()} /></td>
                    <td className="mono">{nos.get(n.id)}</td>
                    {n.kind === "group" ? (
                      <td colSpan={3} style={{ paddingLeft: 6 + r.depth * 14 }}><b>{n.alias || n.name || "(group)"}</b> <span className="muted">{n.children.length} lines</span></td>
                    ) : (
                      <>
                        <td style={{ paddingLeft: 6 + r.depth * 14 }}>{id!.manufacturer}</td>
                        <td className="mono">{id!.partNumber}</td>
                        <td className="c-desc">{id!.description}</td>
                      </>
                    )}
                    <td>{n.qty}</td>
                    <td className="mono">{n.tags.slice(0, 3).join(", ")}{n.tags.length > 3 ? "…" : ""}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="muted">{ql ? "Nothing matches." : "This unit is empty."}</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "master" && (
          <table className="mini wide ngtbl">
            <thead><tr><th aria-label="Pick" /><th>Manufacturer</th><th>Part number</th><th className="c-desc">Description</th><th>Qty</th></tr></thead>
            <tbody>
              {parts.map((p) => {
                const on = p.id in masters;
                return (
                  <tr key={p.id} className={on ? "picked" : ""}>
                    <td><input type="checkbox" aria-label={`Pick ${p.partNumber}`} checked={on} onChange={() => setMasters((m) => { const c = { ...m }; if (on) delete c[p.id]; else c[p.id] = 1; return c; })} /></td>
                    <td>{p.manufacturer}</td><td className="mono">{p.partNumber}</td><td className="c-desc">{p.description}</td>
                    <td><input type="number" min={1} aria-label={`Quantity of ${p.partNumber}`} value={masters[p.id] ?? 1} disabled={!on} onChange={(e) => setMasters((m) => ({ ...m, [p.id]: Math.max(1, Math.round(Number(e.target.value) || 1)) }))} style={{ width: 60 }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === "tpl" && (
          <table className="mini wide ngtbl">
            <thead><tr><th aria-label="Pick" /><th>Folder</th><th>Code</th><th>Name</th><th>Kind</th><th>Latest</th></tr></thead>
            <tbody>
              {tplRows.map((t) => {
                const on = tpls.includes(t.id);
                const v = t.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor)[0];
                return (
                  <tr key={t.id} className={on ? "picked" : ""} onClick={() => setTpls((s) => (on ? s.filter((x) => x !== t.id) : [...s, t.id]))}>
                    <td><input type="checkbox" aria-label={`Pick template ${t.name}`} checked={on} readOnly /></td>
                    <td className="muted">{t.folder || "/"}</td><td className="mono">{t.code}</td><td>{t.name}</td><td>{t.kind}</td><td>{v ? `v${v.major}.${v.minor}` : "—"}</td>
                  </tr>
                );
              })}
              {!tplRows.length && <tr><td colSpan={6} className="muted">No templates.</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "asm" && (
          <table className="mini wide ngtbl">
            <thead><tr><th aria-label="Pick" /><th>Assembly group</th><th>Mounting</th><th>Lines</th></tr></thead>
            <tbody>
              {asmRows.map((a) => {
                const on = asmSel.includes(a.id);
                let k = 0;
                walk(a.root.children, (n) => n.kind === "part" && k++);
                return (
                  <tr key={a.id} className={on ? "picked" : ""} onClick={() => setAsmSel((s) => (on ? s.filter((x) => x !== a.id) : [...s, a.id]))}>
                    <td><input type="checkbox" aria-label={`Pick assembly ${a.label}`} checked={on} readOnly /></td>
                    <td>{a.label}</td><td>{a.root.layout ? ASM_MOUNTS.find(([m]) => m === a.root.layout!.mount)?.[1] : "no layout"}</td><td>{k}</td>
                  </tr>
                );
              })}
              {!asmRows.length && <tr><td colSpan={4} className="muted">No project assembly groups.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <div className="mf">
        {!existing && (
          <>
            <label className="ctl">Name<input type="text" aria-label="Group name" value={name} placeholder={autoName || "e.g. PDU.01"} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} /></label>
            <label className="ctl">Mounting
              <select aria-label="Mounting" value={mount} onChange={(e) => setMount(e.target.value as AsmMount)}>
                {ASM_MOUNTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </label>
            {mount === "rack" && (
              <label className="ctl">U<select aria-label="Rack units" value={ru} onChange={(e) => setRu(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => i + 1).map((u) => <option key={u} value={u}>{u}U</option>)}</select></label>
            )}
            {targets && targets.length > 0 && (
              <label className="ctl">Into
                <select aria-label="Target layout" value={target} onChange={(e) => setTarget(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
              </label>
            )}
          </>
        )}
        <span className="info">{nSel} picked{templates.length && tpls.length && !existing ? " · a template's layout is used when it is the only pick" : ""}</span>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!nSel || (!!targets && !targets.length)} onClick={() => onDone({
          name: name.trim() || autoName || "NEW GROUP", mount, rackUnits: ru, sources: src, target,
          masters: Object.entries(masters).map(([partId, qty]) => ({ partId, qty })), templates: templates.filter((t) => tpls.includes(t.id)), asms: asmSel,
        })}>{existing ? "Add" : "Create group"}</button>
      </div>
    </Modal>
  );
}
