import { SPEC_TEMPLATES, mergeSpecFields, type CustomFieldDef, type CustomFieldType, type Part, type Subcategory } from "@fpl/core";
import { useState } from "react";
import { api, errMsg } from "../api";
import { Modal, useUi } from "../ui";
import { ListIn, TextIn } from "./shared";

/** Categories / subcategories: tag prefix, custom fields and custom port types per subcategory. */
export function SubcatEditor({ subcats, parts, onChanged, onClose }: { subcats: Subcategory[]; parts: Part[]; onChanged: () => Promise<void> | void; onClose: () => void }) {
  const ui = useUi();
  const [open, setOpen] = useState<string | null>(null);
  const cats = [...new Set(subcats.map((s) => s.category))];
  const used = (id: string) => parts.filter((p) => p.subcategoryId === id).length;
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await onChanged();
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const upd = (s: Subcategory, patch: Partial<Subcategory>) => run(() => api.subcats.update(s.id, patch));
  const move = (s: Subcategory, d: -1 | 1) => {
    const l = subcats.slice();
    const i = l.findIndex((x) => x.id === s.id);
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    run(() => api.subcats.reorder(l.map((x) => x.id)));
  };
  return (
    <Modal onClose={onClose} label="Subcategories">
      <div className="mh">
        <h3>Categories & subcategories</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>Each subcategory sets the default device-tag prefix, its custom fields and extra port types.</span>
      </div>
      <div className="mb">
        <table className="mini wide">
          <thead><tr><th>Category</th><th>Subcategory</th><th>Tag prefix</th><th>Specifications</th><th>Port types</th><th>Parts</th><th /></tr></thead>
          <tbody>
            {cats.map((c) =>
              subcats.filter((s) => s.category === c).map((s) => [
                <tr key={s.id} className={open === s.id ? "sel" : undefined}>
                  <td><TextIn label="Category" value={s.category} onChange={(v) => upd(s, { category: v })} width={130} /></td>
                  <td><TextIn label="Subcategory" value={s.name} onChange={(v) => upd(s, { name: v })} width={220} /></td>
                  <td><TextIn label="Tag prefix" value={s.tagPrefix} mono onChange={(v) => upd(s, { tagPrefix: v })} width={90} /></td>
                  <td>
                    <button type="button" className="btn-ghost" onClick={() => setOpen(open === s.id ? null : s.id)}>
                      {s.fields.length ? `${s.fields.length} fields` : <span className="muted">none</span>} ▾
                    </button>
                  </td>
                  <td><ListIn label="Port types" value={s.portTypes} placeholder="e.g. IRIG-B, Relay out" onChange={(v) => upd(s, { portTypes: v })} width={200} /></td>
                  <td className="muted">{used(s.id) || ""}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="btn-ghost" aria-label="Move up" onClick={() => move(s, -1)}>↑</button>
                    <button type="button" className="btn-ghost" aria-label="Move down" onClick={() => move(s, 1)}>↓</button>
                    <button type="button" className="btn-ghost btn-danger" aria-label="Delete subcategory" onClick={async () => {
                      const n = used(s.id);
                      if (!(await ui.confirm(`Delete subcategory “${s.name}”?${n ? ` ${n} part(s) keep their category but lose the subcategory.` : ""}`, "Delete"))) return;
                      run(() => api.subcats.remove(s.id));
                    }}>✕</button>
                  </td>
                </tr>,
                open === s.id && (
                  <tr key={s.id + ":f"} className="sel">
                    <td colSpan={7}>
                      <div className="toolbar" style={{ marginBottom: 6 }}>
                        <span className="muted" style={{ fontSize: 12.5 }}>Specification fields: the common selection and sizing criteria for every manufacturer of this device type.</span>
                        <span className="grow" />
                        <select aria-label="Standard template" defaultValue="" onChange={(e) => {
                          const t = SPEC_TEMPLATES[e.target.value];
                          e.target.value = "";
                          if (t) upd(s, { fields: mergeSpecFields(s.fields, t) });
                        }}>
                          <option value="">Add fields from a standard template…</option>
                          {Object.keys(SPEC_TEMPLATES).map((k) => <option key={k} value={k}>{k}{k === s.name ? " (this subcategory)" : ""}</option>)}
                        </select>
                      </div>
                      <FieldDefs fields={s.fields} onChange={(fields) => upd(s, { fields })} />
                    </td>
                  </tr>
                ),
              ]),
            )}
          </tbody>
        </table>
      </div>
      <div className="mf">
        <button type="button" onClick={async () => {
          const name = await ui.prompt("New subcategory name", "");
          if (!name) return;
          const cat = await ui.prompt("Category (Electrical, Mechanical, Network, Control or a new one)", cats[0] ?? "Electrical");
          if (cat == null) return;
          run(() => api.subcats.create({ name, category: cat }));
        }}>+ Subcategory</button>
        <span className="info" />
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

const TYPES: [CustomFieldType, string][] = [["text", "Text"], ["number", "Number"], ["range", "Range (min–max)"], ["bool", "Yes / no"], ["select", "List (one)"], ["multi", "List (several)"], ["certs", "Certifications + PDFs"]];
const keyOf = (label: string) => label.trim().replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toLowerCase()) || "field";

export function FieldDefs({ fields, onChange }: { fields: CustomFieldDef[]; onChange: (f: CustomFieldDef[]) => void }) {
  const set = (i: number, p: Partial<CustomFieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <div className="fdefs">
      {fields.map((f, i) => (
        <div key={i} className="frow tight">
          <label className="f">Label<TextIn label="Label" value={f.label} onChange={(v) => set(i, { label: v, key: f.key || keyOf(v) })} width={160} /></label>
          <label className="f">Key<TextIn label="Key" value={f.key} mono onChange={(v) => set(i, { key: keyOf(v) })} width={120} /></label>
          <label className="f">Type<select value={f.type} onChange={(e) => set(i, { type: e.target.value as CustomFieldType })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="f">Unit<TextIn label="Unit" value={f.unit ?? ""} onChange={(v) => set(i, { unit: v || undefined })} width={60} /></label>
          {(f.type === "select" || f.type === "multi" || f.type === "certs") && <label className="f">Options<ListIn label="Options" value={f.options ?? []} onChange={(v) => set(i, { options: v })} width={220} /></label>}
          <label className="f">Group<TextIn label="Group" value={f.group ?? ""} onChange={(v) => set(i, { group: v || undefined })} width={100} /></label>
          <label className="f">Hint<TextIn label="Hint" value={f.help ?? ""} onChange={(v) => set(i, { help: v || undefined })} width={160} /></label>
          <button type="button" className="btn-ghost" style={{ flex: 0, alignSelf: "flex-end" }} aria-label="Move up" disabled={!i} onClick={() => {
            const l = fields.slice();
            [l[i - 1], l[i]] = [l[i], l[i - 1]];
            onChange(l);
          }}>↑</button>
          <button type="button" className="btn-ghost btn-danger" style={{ flex: 0, alignSelf: "flex-end" }} aria-label="Remove field" onClick={() => onChange(fields.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...fields, { key: `field${fields.length + 1}`, label: `Field ${fields.length + 1}`, type: "text" }])}>+ Field</button>
    </div>
  );
}
