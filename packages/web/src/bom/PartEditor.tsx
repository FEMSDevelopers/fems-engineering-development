import {
  aliasOf, seriesKey, partDims, partDocNames, DEFAULT_NAMING, EMPTY_MECH, type NamingStandard, MOUNT_TYPES, PORT_TYPES, POWER_KINDS, emptyPart, emptyPowerIn, emptyPowerOut, newId, partWatts, portLabels,
  type Part, type PartDoc, type PortGroup, type PowerKind, type Subcategory,
} from "@fpl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { HoldButton, Modal, useHold, useLocal, useUi } from "../ui";
import { DocHoverPreview } from "./DocPreview";
import { canPreview, docStdNames, downloadDoc, downloadDocsZip } from "./docFiles";
import { useEditPartStandard, KindOptions, NAMING_PICK_KEY, NamingStandardBar, useDocKinds, defaultNamingValue, renamePartDocs, resolveNaming, useNamingRules, useNamingStandards } from "./Naming";
import { PartViews } from "./PartViews";
import { OemFill } from "./OemFill";
import { AsmDescTab, ProjectPnTab } from "./PnFormat";
import { useMfrAliases } from "./aliases";
import { SpecFields } from "./SpecFields";
import { EffConfig } from "./EffConfig";
import { CertificateList, isCertDoc } from "./Certs";
import { useUnits } from "./store";
import { ListIn, NumIn, TextIn, fmtN } from "./shared";

type Draft = Omit<Part, "id"> & { id?: string };

/** Add / edit one master part: general, mechanical, power feed, power output, ports, custom fields and documents. */
type PeTab = "info" | "cfg" | "cad" | "docs";
const PE_TABS: [PeTab, string][] = [["info", "Item information"], ["cfg", "Configuration & standards"], ["cad", "CAD"], ["docs", "Documentation"]];
const LB = 0.45359237;
/** Stored mm → shown mm / in, and back. */
const mmTo = (mm: number | null | undefined, u: "mm" | "in") => (mm == null ? null : u === "mm" ? mm : Math.round((mm / 25.4) * 1000) / 1000);
const toMm = (v: number | null, u: "mm" | "in") => (v == null ? null : u === "mm" ? v : Math.round(v * 25.4 * 100) / 100);
/** Stored kg → shown g / lb, and back. */
const kgTo = (kg: number | null | undefined, u: "g" | "lb") => (kg == null ? null : u === "g" ? Math.round(kg * 1000 * 100) / 100 : Math.round((kg / LB) * 1000) / 1000);
const toKg = (v: number | null, u: "g" | "lb") => (v == null ? null : u === "g" ? Math.round(v * 1000) / 1e6 : Math.round(v * LB * 1e6) / 1e6);

export function PartEditor({
  part, subcats, parts = [], onSaved, onClose, onPartSaved, focus,
}: {
  /** Scroll to a section when opened (e.g. "docs" from the BOM builder's DocType column). */
  focus?: "docs";
  /** Existing part, or a template for a new one (no id). */
  part: Draft | null;
  subcats: Subcategory[];
  /** Master parts (product series suggestions). */
  parts?: Part[];
  /** Another part of the master list was saved from here (bulk OEM fill). */
  onPartSaved?: (p: Part) => void;
  onSaved: (p: Part) => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const [d, setD] = useState<Draft>(() => ({ ...emptyPart(), ...(part ?? {}), mech: { ...EMPTY_MECH, ...(part?.mech ?? {}) } }));
  const [busy, setBusy] = useState(false);
  const [docNonce, setDocNonce] = useState(0);
  // Product-series documents dialog (P-Series tag or the Product series field held 0.3 s).
  const [seriesDlg, setSeriesDlg] = useState(false);
  // Manufacturer and product series as stored: the documents listed (and ⏫ moves) follow the saved part.
  const [saved, setSaved] = useState({ manufacturer: part?.id ? part.manufacturer ?? "" : "", series: part?.id ? part.series ?? "" : "" });
  const partSeries = d.id && saved.series.trim() ? { mfr: saved.manufacturer, series: saved.series } : null;
  // Click and hold the Documentation tab 0.4 s: every document and certificate of the part (product-series ones included)
  // in one zip — Documents/ and Certificates/ folders, standard names, links as .url files — with an index at the root.
  const editStd = useEditPartStandard();
  const peAliases = useMfrAliases();
  const dlTab = useHold(400, async () => {
    if (!d.id) return ui.toast("Save the part first");
    try {
      const all = (await api.parts.docs(d.id)).filter((x) => x.fileName || x.url);
      if (!all.length) return ui.toast("No documents or certificates to download");
      const names = docStdNames(editStd.std, all, { manufacturer: saved.manufacturer || d.manufacturer, partNumber: d.partNumber, series: saved.series, mfrAlias: aliasOf(peAliases, d.manufacturer) }, subcats.find((s) => s.id === d.subcategoryId)?.name);
      const name = `${[d.manufacturer, d.partNumber].filter(Boolean).join(" ")} documentation`;
      await downloadDocsZip(name, all, names, (x) => (isCertDoc(x) ? "Certificates" : "Documents"), name);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  });
  const seriesHold = useHold(300, () => setSeriesDlg(true));
  const docsFocused = useRef(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const sub = subcats.find((s) => s.id === d.subcategoryId);
  const cats = useMemo(() => [...new Set(subcats.map((s) => s.category).filter(Boolean))], [subcats]);
  const portTypes = [...new Set([...PORT_TYPES, ...(sub?.portTypes ?? []), ...d.ports.map((p) => p.type)])];
  const extraKeys = Object.keys(d.custom).filter((k) => !sub?.fields.some((f) => f.key === k));

  const save = async () => {
    if (!d.partNumber.trim()) return ui.toast("Part number is required");
    setBusy(true);
    try {
      const { id, docCount: _dc, updatedAt: _u, ...body } = d;
      const p = id ? await api.parts.update(id, body) : await api.parts.create(body);
      onSaved(p);
      setSaved({ manufacturer: p.manufacturer, series: p.series });
      if (!id) setD({ ...d, id: p.id });
      ui.toast(id ? "Part saved" : "Part created — you can attach documents now");
      if (id) onClose();
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const pi = d.powerIn;
  const po = d.powerOut;
  const setPi = (k: keyof NonNullable<Draft["powerIn"]>, v: unknown) => set("powerIn", { ...(pi ?? emptyPowerIn()), [k]: v });
  const setPo = (k: keyof NonNullable<Draft["powerOut"]>, v: unknown) => set("powerOut", { ...(po ?? emptyPowerOut()), [k]: v });
  const setMech = (k: keyof Draft["mech"], v: unknown) => set("mech", { ...d.mech, [k]: v });
  const setPort = (i: number, patch: Partial<PortGroup>) => set("ports", d.ports.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const w = partWatts(d);
  const [oem, setOem] = useState(false);
  const seriesList = useMemo(() => {
    const m = new Map<string, number>();
    const mf = d.manufacturer.trim().toLowerCase();
    for (const p of parts) if (p.series && (!mf || p.manufacturer.trim().toLowerCase() === mf) && (!d.subcategoryId || p.subcategoryId === d.subcategoryId)) m.set(p.series, (m.get(p.series) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [parts, d.manufacturer, d.subcategoryId]);
  const specGroups = [...new Set((sub?.fields ?? []).map((f) => f.group || "Specifications"))];
  // Certification groups (certified standards) are shown in Documentation, the other groups in Configuration & standards.
  const certGroups = specGroups.filter((g) => /certif/i.test(g) || (sub?.fields ?? []).some((f) => (f.group || "Specifications") === g && f.type === "certs"));
  const cfgGroups = specGroups.filter((g) => !certGroups.includes(g));
  const [tab, setTab] = useLocal<PeTab>("fpl.bom.peTab", "info");
  useEffect(() => {
    if (focus === "docs") setTab("docs");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const [units, setUnits] = useUnits();
  const aliases = useMfrAliases();

  return (
    <Modal onClose={onClose} label="Part">
      <div className="mh pe-head">
        <h3>{d.id ? "Edit part" : "New part"}</h3>
        <span className="muted mono">{[d.manufacturer, d.partNumber].filter(Boolean).join(" · ")}</span>
        <div className="tabs pe-tabs" role="tablist" aria-label="Edit part sections">
          {PE_TABS.map(([k, l]) => k === "docs"
            ? <button key={k} type="button" role="tab" aria-selected={tab === k} className="tab holdtab" onClick={() => setTab(k)} {...dlTab}
                title="Click and hold 0.4 s: download every document and certificate (zip: Documents and Certificates folders, index with links)">{l}</button>
            : <button key={k} type="button" role="tab" aria-selected={tab === k} className="tab" onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <span className="seg mini" role="group" aria-label="Units: imperial or metric" title="IMP: weight in lb, temperatures in °F, dimensions in inches · M: weight in g, temperatures in °C, dimensions in mm (values are stored in kg, °C and mm)">
          {(["IMP", "M"] as const).map((u) => (
            <button key={u} type="button" aria-pressed={units.sys === u} onClick={() => setUnits(u === "IMP" ? { sys: "IMP", weight: "lb", temp: "F", dim: "in" } : { sys: "M", weight: "g", temp: "C", dim: "mm" })}>{u}</button>
          ))}
        </span>
      </div>
      <div className="mb pe">
        {tab === "info" && (
          <>
        <fieldset>
          <legend>General</legend>
          <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: -6 }}>
            <button type="button" onClick={() => setOem(true)} disabled={!d.partNumber.trim() && !d.manufacturer.trim()} title="Read the OEM product page or datasheet (link, stored datasheet or PDF) and review the values before they fill this part">Fill from OEM page / datasheet…</button>
          </div>
          <div className="pe-grid">
            <label className="f">Category
              <select value={d.category} onChange={(e) => set("category", e.target.value)}>
                <option value="">—</option>
                {[...new Set([...cats, d.category].filter(Boolean))].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="f">Subcategory
              <select
                value={d.subcategoryId ?? ""}
                onChange={(e) => {
                  const s = subcats.find((x) => x.id === e.target.value);
                  setD((x) => ({ ...x, subcategoryId: s?.id ?? null, category: s?.category || x.category }));
                }}
              >
                <option value="">—</option>
                {(cats.length ? cats : [""]).map((c) => (
                  <optgroup key={c} label={c || "Other"}>
                    {subcats.filter((s) => s.category === c && (!d.category || s.category === d.category || s.id === d.subcategoryId)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="f">Manufacturer<input type="text" value={d.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} /></label>
            <label className="f" title="Product series / family of the manufacturer (e.g. Siemens 3VA, 3VJ, QR MCCBs). Project PN rules can target a manufacturer + subcategory + series.">Product series
              <input type="text" list="pe-series" value={d.series} onChange={(e) => set("series", e.target.value)} placeholder="QUINT, 3VA, FortiSwitch Rugged…" {...seriesHold}
                title="Hold 0.3s to open the product-series documents (shared by every part of the manufacturer's series)" />
              <datalist id="pe-series">{seriesList.map(([s, n]) => <option key={s} value={s}>{`${n} part${n === 1 ? "" : "s"}`}</option>)}</datalist>
            </label>
            <label className="f">Part number<input type="text" className="mono" value={d.partNumber} onChange={(e) => set("partNumber", e.target.value)} /></label>
            <label className="f">Device tag prefix<input type="text" className="mono" value={d.tagPrefix} placeholder={sub?.tagPrefix || "e.g. PS."} onChange={(e) => set("tagPrefix", e.target.value)} /></label>
            <label className="f span2">Description<textarea rows={2} value={d.description} onChange={(e) => set("description", e.target.value)} /></label>
            <label className="f">Typical vendor(s)<input type="text" value={d.vendor} onChange={(e) => set("vendor", e.target.value)} /></label>
            <label className="f">Vendor contact<input type="text" value={d.vendorContact} onChange={(e) => set("vendorContact", e.target.value)} /></label>
            <label className="f">Status
              <select value={d.status} onChange={(e) => set("status", e.target.value as Part["status"])}>
                <option value="active">Active</option><option value="spares">Spares only</option><option value="obsolete">Obsolete</option>
              </select>
            </label>
            <div className="frow tight">
              <label className="f">In stock<NumIn label="In stock" value={d.stock} onChange={(v) => set("stock", v)} width={80} /></label>
              <label className="f">On order<NumIn label="On order" value={d.onOrder} onChange={(v) => set("onOrder", v)} width={80} /></label>
              <label className="f">Unit price<NumIn label="Unit price" value={d.price} onChange={(v) => set("price", v)} width={90} /></label>
            </div>
            <label className="f span2">Notes<input type="text" value={d.notes} onChange={(e) => set("notes", e.target.value)} /></label>
            <label className="f span-all" title="Long OEM description (catalog / flyer / datasheet text); the Description above stays the BOM description of the part number">OEM desc<textarea rows={3} value={d.oemDesc ?? ""} onChange={(e) => set("oemDesc", e.target.value)} placeholder="Long description from the OEM catalog, flyer or datasheet" /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Mechanical</legend>
          <div className="frow tight">
            <label className="f">Mounting
              <select value={d.mech.mount} onChange={(e) => setMech("mount", e.target.value)}>
                {MOUNT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="f">Rack units (U)<NumIn label="Rack units" value={d.mech.rackUnits} onChange={(v) => setMech("rackUnits", v)} width={70} /></label>
            <label className="f">DIN width (mm)<NumIn label="DIN width" value={d.mech.dinWidthMm} onChange={(v) => setMech("dinWidthMm", v)} width={80} /></label>
            <label className="f">Weight ({units.weight})
              <span className="unitin">
                <NumIn label={`Weight (${units.weight})`} value={kgTo(d.mech.weightKg, units.weight)} onChange={(v) => setMech("weightKg", toKg(v, units.weight))} width={80} />
                <span className="seg mini" role="group" aria-label="Weight unit">
                  {(["g", "lb"] as const).map((u) => <button key={u} type="button" aria-pressed={units.weight === u} onClick={() => setUnits({ ...units, weight: u })}>{u}</button>)}
                </span>
              </span>
            </label>
            <label className="chk-l" style={{ alignSelf: "flex-end" }} title="Rack equipment that takes the same U on the front and the rear; the rear elevation shows it with the assembly descriptions and device tags">
              <input type="checkbox" checked={!!d.mech.fullDepth} onChange={(e) => setMech("fullDepth", e.target.checked)} /> Full depth (front and rear)
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>
            <label className="chk-l"><input type="checkbox" checked={!!pi} onChange={(e) => set("powerIn", e.target.checked ? emptyPowerIn() : null)} /> Power feed (input)</label>
          </legend>
          {pi && (
            <div className="frow tight">
              <label className="f">Type<select value={pi.kind} onChange={(e) => setPi("kind", e.target.value as PowerKind)}>{POWER_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="f">Nominal V<NumIn label="Nominal voltage" value={pi.voltage} onChange={(v) => setPi("voltage", v)} width={70} /></label>
              <label className="f">Rated range<input type="text" value={pi.range} placeholder="100-240VAC" onChange={(e) => setPi("range", e.target.value)} style={{ width: 120 }} /></label>
              <label className="f">Max W<NumIn label="Max watts" value={pi.watts} onChange={(v) => setPi("watts", v)} width={80} /></label>
              <label className="f">Max A<NumIn label="Max amps" value={pi.amps} onChange={(v) => setPi("amps", v)} width={70} /></label>
              {pi.kind !== "DC" && <label className="f">PF<NumIn label="Power factor" value={pi.pf} onChange={(v) => setPi("pf", v)} width={60} placeholder="1" /></label>}
              <label className="f">Feeds<NumIn label="Number of feeds" value={pi.feeds} onChange={(v) => setPi("feeds", Math.max(0, Math.round(v ?? 1)))} width={50} /></label>
              <label className="f">Feeder terminals<ListIn label="Feeder terminals" value={pi.terminals} placeholder="L1, L2/N, G" onChange={(v) => setPi("terminals", v)} width={160} /></label>
              {w != null && pi.watts == null && <span className="muted">≈ {fmtN(w)} W</span>}
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>
            <label className="chk-l"><input type="checkbox" checked={!!po} onChange={(e) => set("powerOut", e.target.checked ? emptyPowerOut() : null)} /> Power output (supplies, UPS, inverters, PDUs)</label>
          </legend>
          {po && (
            <div className="frow tight">
              <label className="f">Type<select value={po.kind} onChange={(e) => setPo("kind", e.target.value as PowerKind)}>{POWER_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="f">Output V<NumIn label="Output voltage" value={po.voltage} onChange={(v) => setPo("voltage", v)} width={70} /></label>
              <label className="f">Rated W<NumIn label="Rated watts" value={po.watts} onChange={(v) => setPo("watts", v)} width={80} /></label>
              <label className="f">Rated A<NumIn label="Rated amps" value={po.amps} onChange={(v) => setPo("amps", v)} width={70} /></label>
              <label className="f">Efficiency<NumIn label="Efficiency" value={po.efficiency} onChange={(v) => setPo("efficiency", v != null && v > 1 ? v / 100 : v)} width={70} placeholder="0.92" /></label>
              <label className="f">Output terminals<ListIn label="Output terminals" value={po.terminals} placeholder="+, +, −, −" onChange={(v) => setPo("terminals", v)} width={160} /></label>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Ports</legend>
          {d.ports.length > 0 && (
            <table className="mini">
              <thead><tr><th>Type</th><th>Count</th><th>Speed</th><th>Label pattern</th><th>Notes</th><th>Labels</th><th /></tr></thead>
              <tbody>
                {d.ports.map((p, i) => (
                  <tr key={p.id}>
                    <td>
                      <select value={p.type} aria-label="Port type" onChange={(e) => setPort(i, { type: e.target.value })}>
                        {portTypes.map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </td>
                    <td><NumIn label="Count" value={p.count} onChange={(v) => setPort(i, { count: Math.max(0, Math.round(v ?? 0)) })} width={55} /></td>
                    <td><input type="text" value={p.speed} placeholder="1G" onChange={(e) => setPort(i, { speed: e.target.value })} style={{ width: 90 }} /></td>
                    <td><input type="text" className="mono" value={p.label} placeholder="Port {n}" onChange={(e) => setPort(i, { label: e.target.value })} style={{ width: 120 }} /></td>
                    <td><input type="text" value={p.notes} onChange={(e) => setPort(i, { notes: e.target.value })} /></td>
                    <td className="muted mono" style={{ fontSize: 11.5 }}>{portLabels(p).slice(0, 3).join(", ")}{p.count > 3 ? " …" : ""}</td>
                    <td>
                      <button type="button" className="btn-ghost" aria-label="Move up" disabled={!i} onClick={() => set("ports", swap(d.ports, i, i - 1))}>↑</button>
                      <button type="button" className="btn-ghost btn-danger" aria-label="Remove port group" onClick={() => set("ports", d.ports.filter((_, j) => j !== i))}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="toolbar">
            <button type="button" onClick={() => set("ports", [...d.ports, { id: newId(), type: sub?.portTypes[0] ?? "RJ45", count: 1, speed: "", label: "", notes: "" }])}>+ Port group</button>
            <span className="muted" style={{ fontSize: 12 }}>Label pattern: <code>Port {"{n}"}</code> numbers each port. Port types for this subcategory are edited in Subcategories….</span>
          </div>
        </fieldset>
          </>
        )}
        {tab === "cfg" && (
          <>
        {/* Configuration & standards: every former sub-tab as its own section, one above the other (Certification is in Documentation). */}
        <fieldset>
          <legend>Configuration{sub ? ` · ${sub.name}` : ""}</legend>
          {/* SKU, configuration codes, effective part number / description / price: saved together as configurations (versions), with the Apply switch. */}
          <EffConfig d={d} sub={sub?.name ?? ""} specFields={sub?.fields} aliases={aliases}
            onChange={(x) => setD((p) => ({ ...p, ...x }))}
            persist={async (x) => {
              if (!d.id) return; // a new part: stored when it is created
              const p = await api.parts.update(d.id, x);
              setD((cur) => ({ ...cur, effPn: p.effPn, effDesc: p.effDesc }));
              onPartSaved?.(p);
            }} />
          {!sub && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Pick a subcategory to get its specification sections (selection and sizing criteria shared by every manufacturer of that device type).</p>}
          {sub && !sub.fields.length && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>No specification fields for {sub.name} yet. Add them (or load the standard template) in Subcategories….</p>}
        </fieldset>
        {sub && cfgGroups.map((g) => (
          <fieldset key={g}>
            <legend>{g}</legend>
            <SpecFields onlyGroup={g} fields={sub.fields} custom={d.custom} onChange={(c) => set("custom", c)} partId={d.id} description={d.description} partNumber={d.partNumber} onDocsChanged={() => setDocNonce((n) => n + 1)} />
          </fieldset>
        ))}
        {extraKeys.length > 0 && (
          <fieldset>
            <legend>Other fields</legend>
            <div className="frow tight">
              {extraKeys.map((k) => (
                <label key={k} className="f" title="Not a field of this subcategory (kept from another subcategory or an import)">
                  <span>{k} <span className="muted">(other)</span></span>
                  <span style={{ display: "flex", gap: 4 }}>
                    <input type="text" value={Array.isArray(d.custom[k]) ? (d.custom[k] as unknown[]).join(", ") : String(d.custom[k])} readOnly={typeof d.custom[k] !== "string"} onChange={(e) => set("custom", { ...d.custom, [k]: e.target.value })} />
                    <button type="button" className="btn-ghost btn-danger" aria-label={`Remove ${k}`} onClick={() => {
                      const c = { ...d.custom };
                      delete c[k];
                      set("custom", c);
                    }}>✕</button>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset>
          <legend>Project PN</legend>
          <ProjectPnTab part={{ ...(d as Part), id: d.id ?? "" }} sub={sub?.name ?? ""} src={{ parts, subcats }} specFields={sub?.fields} />
        </fieldset>
        <fieldset>
          <legend>Assembly Descriptions</legend>
          <AsmDescTab part={{ ...(d as Part), id: d.id ?? "" }} sub={sub?.name ?? ""} src={{ parts, subcats }} specFields={sub?.fields} />
        </fieldset>
          </>
        )}
        {tab === "cad" && (
          <>
        <fieldset>
          <legend>Dimensions &amp; 2D views</legend>
          <label className="chk-l" title="On: Mechanical Design draws the uploaded views below. Off: a generic box of the part's size, as if no view was uploaded.">
            <input type="checkbox" checked={d.mech.useViews !== false} onChange={(e) => setMech("useViews", e.target.checked)} /> Draw these 2D views in layouts (off: generic box)
          </label>
          <div className="frow tight">
            {/* Inputs in mm or inches (stored in mm). */}
            <span className="seg mini" role="group" aria-label="Dimension unit" style={{ alignSelf: "flex-end", marginBottom: 4 }} title="Type the dimensions in millimetres or inches (stored in mm)">
              {(["mm", "in"] as const).map((u) => <button key={u} type="button" aria-pressed={units.dim === u} onClick={() => setUnits({ ...units, dim: u })}>{u}</button>)}
            </span>
            <label className="f">x · width ({units.dim})<NumIn label={`Width x (${units.dim})`} value={mmTo(d.mech.widthMm, units.dim)} onChange={(v) => setMech("widthMm", toMm(v, units.dim))} width={80} /></label>
            <label className="f">y · height ({units.dim})<NumIn label={`Height y (${units.dim})`} value={mmTo(d.mech.heightMm, units.dim)} onChange={(v) => setMech("heightMm", toMm(v, units.dim))} width={80} /></label>
            <label className="f">z · depth ({units.dim})<NumIn label={`Depth z (${units.dim})`} value={mmTo(d.mech.depthMm, units.dim)} onChange={(v) => setMech("depthMm", toMm(v, units.dim))} width={80} /></label>
            <span className="sep" style={{ alignSelf: "flex-end", height: 28 }} />
            <label className="f" title="Extra width arranged around the part (cable bend, connectors, side clearance)">+ x adder<NumIn label={`x adder (${units.dim})`} value={mmTo(d.mech.addXMm, units.dim)} onChange={(v) => setMech("addXMm", toMm(v, units.dim))} width={70} /></label>
            <label className="f" title="Extra height (wire bend radius, fan clearance…)">+ y adder<NumIn label={`y adder (${units.dim})`} value={mmTo(d.mech.addYMm, units.dim)} onChange={(v) => setMech("addYMm", toMm(v, units.dim))} width={70} /></label>
            <label className="f" title="Extra depth (connectors and cables in front, handles…)">+ z adder<NumIn label={`z adder (${units.dim})`} value={mmTo(d.mech.addZMm, units.dim)} onChange={(v) => setMech("addZMm", toMm(v, units.dim))} width={70} /></label>
            {(() => {
              const o = partDims(d as Part);
              const f = (n: number | null) => (n == null ? "?" : units.dim === "in" ? fmtN(n / 25.4, 2) : fmtN(n, 1)) || "?";
              return <span className="muted" style={{ alignSelf: "flex-end", fontSize: 12.5 }}>Overall used in Mechanical Design: <b className="mono">{f(o.x)} × {f(o.y)} × {f(o.z)} {units.dim}</b>{units.dim === "in" && o.x != null ? <span> ({fmtN(o.x, 1)} × {fmtN(o.y, 1)} × {fmtN(o.z, 1)} mm)</span> : null}</span>;
            })()}
          </div>
          {d.id ? (
            <PartViews part={{ id: d.id, mech: d.mech, partNumber: d.partNumber, sku: d.sku, manufacturer: d.manufacturer, subcategoryId: d.subcategoryId, series: d.series }} parts={parts} subName={sub?.name} onDims={(x) => setD((p) => ({ ...p, mech: { ...p.mech, widthMm: x.x, heightMm: x.y, depthMm: x.z } }))} />
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Save the part first to import a STEP model or front / back / top / bottom / side views (SVG, DXF, PDF).</p>
          )}
        </fieldset>
          </>
        )}
        {tab === "docs" && (
          <>
        <fieldset ref={(el) => {
          if (el && focus === "docs" && !docsFocused.current) {
            docsFocused.current = true;
            requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
          }
        }}>
          <legend>Documents</legend>
          {d.id ? <DocList key={`${docNonce}|${seriesKey(saved.manufacturer, saved.series)}`} hideCerts partId={d.id} part={{ manufacturer: saved.manufacturer, partNumber: d.partNumber, series: saved.series }} sub={sub?.name} onSeries={() => setSeriesDlg(true)} /> : <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Save the part first to attach datasheets, manuals, guides and links.</p>}
        </fieldset>
        <fieldset>
          <legend>Certification</legend>
          {sub && certGroups.map((g) => (
            <SpecFields key={g} onlyGroup={g} fields={sub.fields} custom={d.custom} onChange={(c) => set("custom", c)} partId={d.id} description={d.description} partNumber={d.partNumber} onDocsChanged={() => setDocNonce((n) => n + 1)}
              nonce={docNonce} partSeries={partSeries} onSeries={() => setSeriesDlg(true)} />
          ))}
          {d.id ? <CertificateList partId={d.id} nonce={docNonce} onChanged={() => setDocNonce((n) => n + 1)} partSeries={partSeries} onSeries={() => setSeriesDlg(true)}
            part={{ manufacturer: saved.manufacturer || d.manufacturer, partNumber: d.partNumber, series: saved.series }} sub={sub?.name} /> : <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Save the part first to attach certificates.</p>}
        </fieldset>
          </>
        )}
      </div>
      <div className="mf">
        <span className="info">{d.id ? "Changes apply to the master list; saved BOM versions keep their own snapshot of manufacturer, part number and description." : ""}</span>
        <button type="button" onClick={onClose}>{d.id && part?.id ? "Cancel" : "Close"}</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{d.id ? "Save" : "Create part"}</button>
      </div>
      {seriesDlg && (
        <SeriesDocsModal mfr={d.manufacturer.trim()} series={d.series.trim() || saved.series} parts={parts} subcats={subcats}
          current={d.id ? { id: d.id, manufacturer: d.manufacturer, partNumber: d.partNumber, series: d.series, subcategoryId: d.subcategoryId } : null}
          onPartsChanged={(ps) => {
            ps.forEach((p) => onPartSaved?.(p));
            const me = ps.find((p) => p.id === d.id);
            if (me) (setD((x) => ({ ...x, series: me.series })), setSaved((x) => ({ ...x, series: me.series })));
          }}
          onClose={() => (setSeriesDlg(false), setDocNonce((n) => n + 1))} />
      )}
      {oem && <OemFill onDocsChanged={() => setDocNonce((n) => n + 1)} d={d} fields={sub?.fields ?? []} parts={parts} subcats={subcats} onPartsSaved={(ps) => ps.forEach((p) => onPartSaved?.(p))} onClose={() => setOem(false)} onApply={(p) => (setD(p), setOem(false), ui.toast("Values applied — review and save the part"))} />}
    </Modal>
  );
}

type SeriesPart = { id: string; manufacturer: string; partNumber: string; series: string; subcategoryId: string | null };
const mfrKey = (m: string) => m.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();

/**
 * Product-series documents: upload / link / edit the documents and certificates of one manufacturer + product series,
 * with the same interface as a part's. They are listed under every part of that manufacturer and series (and go into
 * their outputs). Manufacturer: a dropdown of the master parts list's manufacturers (with a filter); product series:
 * every series defined for it. **Rename…** renames the series on every part of the manufacturer (documents follow).
 */
export function SeriesDocsModal({ mfr, series, parts, subcats, current, onPartsChanged, onClose }: {
  mfr: string;
  series: string;
  parts: Part[];
  subcats: Subcategory[];
  /** Part being edited (may have unsaved series), counted as a part of its series. */
  current?: SeriesPart | null;
  /** Parts changed by a rename (master list to update). */
  onPartsChanged?: (ps: Part[]) => void;
  onClose: () => void;
}) {
  const ui = useUi();
  // Local copy of the master list, updated by renames (the parent list may not refresh while this is open).
  const [list, setList] = useState<SeriesPart[]>(() => {
    const l: SeriesPart[] = parts.filter((p) => p.id !== current?.id);
    return current ? [current, ...l] : l;
  });
  // Manufacturers of the master parts list (one per spelling-insensitive key; most used spelling), with part / series counts.
  const mfrs = useMemo(() => {
    const m = new Map<string, { name: string; n: number; series: Set<string>; spell: Map<string, number> }>();
    for (const p of list) {
      const k = mfrKey(p.manufacturer);
      if (!k) continue;
      const e = m.get(k) ?? m.set(k, { name: p.manufacturer.trim(), n: 0, series: new Set(), spell: new Map() }).get(k)!;
      e.n++;
      e.spell.set(p.manufacturer.trim(), (e.spell.get(p.manufacturer.trim()) ?? 0) + 1);
      const sk = seriesKey(p.manufacturer, p.series);
      if (sk) e.series.add(sk);
    }
    for (const e of m.values()) e.name = [...e.spell].sort((a, b) => b[1] - a[1])[0][0];
    return [...m].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [list]);
  const [mk, setMk] = useState(() => mfrKey(mfr) || mfrs[0]?.[0] || "");
  const [mq, setMq] = useState("");
  const mInfo = mfrs.find(([k]) => k === mk)?.[1];
  const mName = mInfo?.name ?? mfr;
  const shownMfrs = mfrs.filter(([k, x]) => k === mk || !mq.trim() || x.name.toLowerCase().includes(mq.trim().toLowerCase()));
  // Distinct series of this manufacturer (one per key; most used spelling), with their parts.
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; parts: SeriesPart[] }>();
    for (const p of list) {
      const k = seriesKey(p.manufacturer, p.series);
      if (!k || k.split("|")[0] !== mk) continue;
      (m.get(k) ?? m.set(k, { name: p.series.trim(), parts: [] }).get(k)!).parts.push(p);
    }
    return [...m].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [list, mk]);
  const [sel, setSel] = useState(() => seriesKey(mfr, series));
  const g = groups.find(([k]) => k === sel)?.[1] ?? groups[0]?.[1];
  const selKey = groups.find(([k]) => k === sel)?.[0] ?? groups[0]?.[0] ?? "";
  const sample = g?.parts.find((p) => p.id === current?.id) ?? g?.parts[0];
  const [nonce, setNonce] = useState(0);
  const rename = async () => {
    if (!g || !sample) return;
    const to = (await ui.prompt(`New name of the product series “${g.name}” of ${mName} (${g.parts.length} part${g.parts.length === 1 ? "" : "s"} follow)`, g.name, "Rename"))?.trim();
    if (!to || to === g.name) return;
    const into = groups.find(([k]) => k === seriesKey(sample.manufacturer, to) && k !== selKey);
    if (into && !(await ui.confirm(`“${into[1].name}” exists already for ${mName} (${into[1].parts.length} parts). Merge “${g.name}” into it? Its documents are merged too.`, "Merge"))) return;
    try {
      const r = await api.parts.seriesRename(sample.manufacturer, g.name, to);
      const by = new Map(r.parts.map((p) => [p.id, p]));
      setList((l) => l.map((p) => (by.has(p.id) ? { ...p, series: by.get(p.id)!.series } : p)));
      setSel(seriesKey(sample.manufacturer, to));
      setNonce((n) => n + 1);
      onPartsChanged?.(r.parts);
      ui.toast(`Product series renamed to “${to}”: ${r.parts.length} part(s)${r.docs ? `, ${r.docs} document(s)` : ""}${r.orients ? `, ${r.orients} STEP orientation(s)` : ""}`);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const ref = g && sample ? { mfr: sample.manufacturer.trim() || mName, series: g.name } : null;
  return (
    <Modal onClose={onClose} label="Product-series documents">
      <div className="mh"><h3>Product-series documents</h3><span className="muted" style={{ fontSize: 12.5 }}>Listed under every part of the manufacturer and product series, and used in their outputs. Standard names use the product series in place of the part number.</span></div>
      <div className="mb">
        <div className="frow tight seriespick">
          <label className="f">Manufacturer
            <span className="mfrpick">
              <input type="search" aria-label="Filter manufacturers" placeholder="Filter…" value={mq} onChange={(e) => {
                setMq(e.target.value);
                const t = e.target.value.trim().toLowerCase();
                const hit = mfrs.filter(([, x]) => x.name.toLowerCase().includes(t));
                if (t && hit.length && !hit.some(([k]) => k === mk)) (setMk(hit[0][0]), setSel(""));
              }} />
              <select aria-label="Manufacturer" value={mk} onChange={(e) => (setMk(e.target.value), setSel(""))}>
                {!mInfo && <option value={mk}>{mfr || "— pick a manufacturer —"}</option>}
                {shownMfrs.map(([k, x]) => <option key={k} value={k}>{x.name} ({x.series.size} series · {x.n} part{x.n === 1 ? "" : "s"})</option>)}
              </select>
            </span>
          </label>
          <label className="f">Product series
            <select aria-label="Product series" value={selKey} onChange={(e) => setSel(e.target.value)}>
              {!groups.length && <option value="">— no product series defined for {mName || "this manufacturer"} —</option>}
              {groups.map(([k, x]) => <option key={k} value={k}>{x.name} ({x.parts.length} part{x.parts.length === 1 ? "" : "s"})</option>)}
            </select>
          </label>
          <button type="button" style={{ alignSelf: "flex-end" }} disabled={!g} onClick={rename} title="Rename this product series: every part of the manufacturer with this series gets the new name; its documents and STEP orientations follow">Rename…</button>
          {g && <span className="muted pseries-parts" style={{ alignSelf: "flex-end", fontSize: 12 }} title={g.parts.map((p) => p.partNumber).join("\n")}>
            Shared by: {g.parts.slice(0, 6).map((p) => p.partNumber || "(no PN)").join(", ")}{g.parts.length > 6 ? ` +${g.parts.length - 6}` : ""}
          </span>}
        </div>
        {g && sample && ref ? (
          <>
            <fieldset>
              <legend>Documents</legend>
              <DocList key={`${selKey}|${nonce}`} partId="" hideCerts series={ref}
                part={{ manufacturer: sample.manufacturer, partNumber: g.name, series: g.name }} sub={subcats.find((s) => s.id === sample.subcategoryId)?.name} />
            </fieldset>
            <fieldset>
              <legend>Certification</legend>
              <CertificateList key={`${selKey}|${nonce}`} partId="" series={ref}
                part={{ manufacturer: sample.manufacturer, partNumber: g.name, series: g.name }} sub={subcats.find((s) => s.id === sample.subcategoryId)?.name} />
            </fieldset>
          </>
        ) : <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Define a product series for this manufacturer (Edit part → Item information → General) to host documents by series.</p>}
      </div>
      <div className="mf"><span className="grow" /><button type="button" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

const swap = <T,>(l: T[], i: number, j: number) => {
  const c = l.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
};
const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/** Documents of one part: uploaded files (stored in the database) and links; titles, prefixes and standard file names. */
export function DocList({ partId, part, sub, hideCerts, series, onSeries }: {
  partId: string;
  /** Part the naming standard is shown for (in product-series mode: a part of the series). */
  part: { manufacturer: string; partNumber: string; series: string };
  sub?: string;
  /** Certificates are listed apart (Documentation → Certification). */
  hideCerts?: boolean;
  /** Product-series mode: the documents of this manufacturer + product series (shared by every part of the series). */
  series?: { mfr: string; series: string };
  /** Part mode: open the product-series documents (P-Series tag held 0.3 s). */
  onSeries?: () => void;
}) {
  const ui = useUi();
  const [docs, setDocs] = useState<PartDoc[]>([]);
  const [kind, setKind] = useState<string>("Datasheet");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const { items: standards, refresh: refreshStd } = useNamingStandards();
  const [stdVal, setStdVal] = useLocal<string>(NAMING_PICK_KEY, "");
  const load = () => (series ? api.parts.seriesDocs(series.mfr, series.series) : api.parts.docs(partId)).then(setDocs).catch((e) => ui.toast(errMsg(e)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId, series?.mfr, series?.series]);
  const hasSeries = !series && !!part.series.trim();
  // Default: the latest version of the most recently updated standard (follows new versions); re-pulled when a standard is saved.
  const pick = stdVal && resolveNaming(stdVal, standards) ? stdVal : defaultNamingValue(standards);
  const std = useNamingRules(pick, standards);
  // Every document type: built-ins + types defined in any naming standard (+ the picked standard's rules, + kinds already used).
  const kindList = useDocKinds([...std.rules.map((r) => r.kind), ...docs.map((d) => d.kind)]);
  const isCertDoc = (x: PartDoc) => x.kind === "Certificate" || !!x.ref?.startsWith("ctype:") || !!x.ref?.startsWith("cert:");
  const shownDocs = hideCerts ? docs.filter((x) => !isCertDoc(x)) : docs;
  const certCount = docs.length - shownDocs.length;
  const files = docs.filter((x) => x.fileName);
  const aliases = useMfrAliases();
  const partA = { ...part, mfrAlias: aliasOf(aliases, part.manufacturer) };
  // Standard names of every document (files and links — links as .url link files); product-series documents (renamed from
  // the product-series documents, shared by every part of the series) as the product-series documents name them, in a
  // P-Series bubble.
  const stdName = docStdNames(std, docs, partA, sub, !!series);
  const ownDocs = series ? docs : docs.filter((x) => !x.seriesName);
  const ownFiles = ownDocs.filter((x) => x.fileName);
  const toRename = ownFiles.filter((x) => stdName.get(x.id) !== x.fileName).length;
  // Click and hold the 💾 header 0.4 s: every document listed in one zip, under their standard names, with an index.
  const dlAll = useHold(400, () => {
    const name = `${[part.manufacturer, series ? series.series : part.partNumber].filter(Boolean).join(" ")} documents`;
    downloadDocsZip(name, shownDocs, stdName, undefined, name).catch((e) => ui.toast(errMsg(e)));
  });
  const upd = async (id: string, body: Parameters<typeof api.parts.updateDoc>[1]) => {
    // Shown at once (checkbox, year), then confirmed by reloading from the database.
    setDocs((l) => l.map((x) => (x.id === id ? ({ ...x, ...body } as PartDoc) : x)));
    try {
      await api.parts.updateDoc(id, body);
      await load();
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const t = title || f.name.replace(/\.[^.]+$/, "");
        if (series) await api.parts.seriesUpload(series.mfr, series.series, f, kind, t);
        else await api.parts.upload(partId, f, kind, t);
      }
      setTitle("");
      await load();
    } catch (e) {
      ui.toast(`Upload failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="docs">
      <div className="toolbar">
        <NamingStandardBar items={standards} value={pick} onChange={(v) => setStdVal(v)} refresh={refreshStd}
          sample={{ part, sub, docs: docs.map((x) => ({ kind: x.kind, title: x.title, fileName: x.fileName, prefix: x.prefix, suffix: x.suffix, ref: x.ref })) }} />
        <span className="grow" />
        <button type="button" disabled={!toRename} title={series ? "Rename the stored files of this product series to the selected standard" : "Rename the stored files of this part to the selected standard (product-series files: from the product-series documents)"} onClick={async () => {
          if (!(await ui.confirm(`Rename ${toRename} file(s) to the standard?`, "Rename"))) return;
          try {
            const n = await renamePartDocs(std, ownDocs, partA, sub);
            ui.toast(`${n} file(s) renamed`);
            await load();
          } catch (e) {
            ui.toast(errMsg(e));
          }
        }}>Rename files to standard{toRename ? ` (${toRename})` : ""}</button>
      </div>
      {hideCerts && certCount > 0 && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{certCount} certificate{certCount === 1 ? "" : "s"} listed under Certification below.</p>}
      {shownDocs.length > 0 && (
        <table className="mini wide doctab">
          <thead><tr><th title="Active documents go into outputs (documentation package and its index). Untick to keep a document without using it.">Active</th><th>Kind</th><th title="Custom prefix used by the naming standard ({prefix}), e.g. submittal or drawing number">Prefix</th><th>Title</th><th title="Custom suffix used by the naming standard ({suffix}), e.g. a revision">Suffix</th><th title="Year the document was published ({year} in naming standards)">Year</th><th className="dl hcol" {...dlAll} title="Download the file (links: a .url link file). Click and hold 0.4 s: download every document listed (zip with an index)">💾</th><th title="PDFs / images: click to open in a new tab, hover for a preview; other files are only downloaded (💾). Links open the page in a new tab.">File / link</th><th>Standard name</th>{!series && <th className="dl" title="Move to the product series of the part (hold 0.5 s): listed under every part of the same manufacturer and product series">⏫</th>}<th />{!series && <th title="Product-series documents (shared by every part of the series); hold the tag 0.3 s to open them" />}</tr></thead>
          <tbody>
            {shownDocs.map((x) => (
              <tr key={x.id} className={[x.active === false && "inactive", !series && x.seriesName && "pseries"].filter(Boolean).join(" ") || undefined}>
                <td className="chk"><input type="checkbox" aria-label={`Active: ${x.title || x.fileName}`} checked={x.active !== false} onChange={(e) => upd(x.id, { active: e.target.checked })} /></td>
                <td>
                  <select value={x.kind} aria-label="Kind" onChange={(e) => upd(x.id, { kind: e.target.value })}>
                    <KindOptions kinds={kindList} value={x.kind} />
                  </select>
                  {x.ref ? <span className="chip info" style={{ marginLeft: 4 }}>{x.ref.replace(/^cert:/, "")}</span> : null}
                </td>
                <td><TextIn label="Prefix" value={x.prefix ?? ""} mono width={90} placeholder="—" onChange={(v) => upd(x.id, { prefix: v.trim() })} /></td>
                <td><TextIn label="Title" value={x.title} width="100%" onChange={(v) => v.trim() && upd(x.id, { title: v.trim() })} /></td>
                <td><TextIn label="Suffix" value={x.suffix ?? ""} mono width={80} placeholder="—" onChange={(v) => upd(x.id, { suffix: v.trim() })} /></td>
                <td><TextIn label="Year published" value={x.year ? String(x.year) : ""} mono width={58} placeholder="—" onChange={(v) => {
                  const t = v.trim();
                  if (!t) return void upd(x.id, { year: null });
                  const n = Number(t);
                  if (!Number.isInteger(n) || n < 1900 || n > 2200) return ui.toast("Year published: a 4-digit year, e.g. 2024");
                  void upd(x.id, { year: n });
                }} /></td>
                <td className="dl">
                  {x.fileName
                    ? <a className="btn-ghost dlbtn" href={api.parts.docUrl(x.id)} download={x.fileName} aria-label={`Download ${x.fileName}`} title={`Download ${x.fileName}`}>💾</a>
                    : <button type="button" className="btn-ghost dlbtn" aria-label={`Download link file ${stdName.get(x.id)}`} title={`Download a link file (${stdName.get(x.id)}) that opens ${x.url}`} onClick={() => downloadDoc(x, stdName.get(x.id))}>💾</button>}
                </td>
                <td className="docfile">
                  {x.fileName
                    ? canPreview(x)
                      ? <DocHoverPreview doc={x}><a href={api.parts.docUrl(x.id, true)} target="_blank" rel="noreferrer">{x.fileName}</a></DocHoverPreview>
                      : <span className="plainfile" title="No preview for this file type — download it with 💾">{x.fileName}</span>
                    : <a href={x.url} target="_blank" rel="noreferrer noopener" title={`Open ${x.url} in a new tab`}>{x.url}</a>}
                  {x.size > 0 && <span className="muted"> · {kb(x.size)}</span>}
                </td>
                <td className={`mono docstd${x.fileName && !(!series && x.seriesName) && stdName.get(x.id) !== x.fileName ? " diff" : ""}`}
                  title={!series && x.seriesName
                    ? `Standard name from product series ${x.seriesMfr} · ${x.seriesName} (the series in place of the part number)${!x.fileName ? " — link file (.url) in downloads and packages" : stdName.get(x.id) === x.fileName ? " — already named to it" : ` — stored as ${x.fileName}; renamed from the product-series documents`}`
                    : !x.fileName ? "Name of the link file (.url, opens the page) in downloads and documentation packages" : stdName.get(x.id) === x.fileName ? "Already named to the standard" : "Name after “Rename files to standard”"}>
                  {!series && x.seriesName
                    ? <span className={`chip pseries-name${x.fileName && stdName.get(x.id) !== x.fileName ? " diff" : ""}`}>{stdName.get(x.id)}</span>
                    : stdName.get(x.id)}
                </td>
                {!series && (
                  <td className="dl">
                    {/* Click and hold 0.5 s: the document moves to the manufacturer + product series of the part. */}
                    <HoldButton ms={500} className="btn-ghost tosrs" label={`Move ${x.title || x.fileName} to the product series`} disabled={!hasSeries || !!x.seriesName}
                      title={x.seriesName ? "Already a product-series document" : hasSeries ? `Move to product series ${part.manufacturer} · ${part.series} (hold 0.5s): listed under every part of the series` : "Define the product series (Item information → General) to move documents to it"}
                      onHold={async () => {
                        try {
                          const m = await api.parts.docToSeries(x.id);
                          ui.toast(`Moved to product series ${m.seriesMfr} · ${m.seriesName}`);
                        } catch (e) {
                          ui.toast(errMsg(e));
                        }
                        load();
                      }}>⏫</HoldButton>
                  </td>
                )}
                <td>
                  {/* Click and hold 0.5 s to delete — no confirmation prompt. */}
                  <HoldButton ms={500} className="btn-ghost btn-danger" label={`Remove document ${x.title || x.fileName}`} disabled={!series && !!x.seriesName}
                    title={!series && x.seriesName ? "Product-series document: delete it from the product-series documents (hold the P-Series tag)" : undefined} onHold={async () => {
                    setDocs((ds) => ds.filter((d) => d.id !== x.id));
                    try {
                      await api.parts.removeDoc(x.id);
                    } catch (e) {
                      ui.toast(errMsg(e));
                    }
                    load();
                  }}>✕</HoldButton>
                </td>
                {!series && (
                  <td>
                    {x.seriesName && (
                      <HoldButton ms={300} className="chip pseries-tag" label={`Product series ${x.seriesMfr} · ${x.seriesName}`}
                        title={`Hosted by product series ${x.seriesMfr} · ${x.seriesName} — listed under every part of the series. Hold 0.3s to open the product-series documents.`}
                        onHold={() => onSeries?.()}>P-Series</HoldButton>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="frow tight">
        <label className="f">Kind<select value={kind} aria-label="New document kind" onChange={(e) => setKind(e.target.value)}><KindOptions kinds={kindList} value={kind} /></select></label>
        <label className="f">Title<input type="text" value={title} placeholder="(file name)" onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="btn" style={{ alignSelf: "flex-end" }}>
          {busy ? "Uploading…" : "Upload file(s)…"}
          <input type="file" multiple disabled={busy} onChange={(e) => (upload(e.target.files), (e.target.value = ""))} />
        </label>
      </div>
      <div className="frow tight">
        <label className="f" style={{ flex: 3 }}>Link (URL)<input type="text" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></label>
        <button
          type="button"
          style={{ alignSelf: "flex-end", flex: "none", whiteSpace: "nowrap" }}
          disabled={!/^https?:\/\//i.test(url.trim())}
          onClick={async () => {
            try {
              const b = { kind, title: title || url.trim(), url: url.trim() };
              if (series) await api.parts.seriesAddLink(series.mfr, series.series, b);
              else await api.parts.addLink(partId, b);
              setUrl("");
              setTitle("");
              load();
            } catch (e) {
              ui.toast(errMsg(e));
            }
          }}
        >
          Add link
        </button>
      </div>
    </div>
  );
}
