import { useUnits } from "./store";
import { isEmptySpec, specText, suggestSpecs, type CustomFieldDef, type Part, type PartDoc, type SpecValue } from "@fpl/core";
import { useEffect, useState } from "react";
import { api, errMsg } from "../api";
import { useLocal, useUi } from "../ui";
import { NumIn } from "./shared";
import { PSeriesTag, ToSeriesBtn, type SeriesRef } from "./seriesUi";

type Custom = Part["custom"];
const isC = (f: CustomFieldDef) => f.unit === "°C" && (f.type === "number" || f.type === "range");
/** °C ↔ °F (stored values stay in °C). */
const toF = (c: number | null) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
const toC = (f: number | null) => (f == null ? null : Math.round(((f - 32) * 5 / 9) * 100) / 100);
const fmtC = (c: number | null) => (c == null ? "?" : String(Math.round(c * 10) / 10));

/**
 * Subcategory specifications of a part, grouped (Protection, Ratings, Input, Output, Certification…).
 * Certifications are ticked per standard, each with its certificate PDF(s) stored as part documents (ref "cert:<standard>").
 */
export function SpecFields({
  fields, custom, onChange, partId, description, partNumber, onDocsChanged, onlyGroup, nonce, partSeries, onSeries,
}: {
  /** Reload the certificate documents when it changes. */
  nonce?: number;
  /** The saved part's product series (⏫ moves a certificate to it) and opening the product-series documents (P-Series tag). */
  partSeries?: SeriesRef;
  onSeries?: () => void;
  fields: CustomFieldDef[];
  custom: Custom;
  onChange: (c: Custom) => void;
  partId?: string;
  description: string;
  partNumber: string;
  onDocsChanged?: () => void;
  /** Show one spec group only (part editor tabs). */
  onlyGroup?: string;
}) {
  const ui = useUi();
  // °F / °C follows the Edit part units (IMP | M, or the °F switch below).
  const [units, setUnits] = useUnits();
  const inF = units.temp === "F";
  const setInF = (f: boolean) => setUnits({ ...units, temp: f ? "F" : "C" });
  const [docs, setDocs] = useState<PartDoc[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const loadDocs = () => (partId ? api.parts.docs(partId).then(setDocs).catch(() => {}) : Promise.resolve());
  useEffect(() => {
    loadDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId, nonce]);
  const put = (k: string, v: SpecValue | null) => {
    const c = { ...custom } as Record<string, SpecValue>;
    if (v == null || isEmptySpec(v)) delete c[k];
    else c[k] = v;
    onChange(c as Custom);
  };
  const groups = [...new Set(fields.map((f) => f.group || "Specifications"))].filter((g) => !onlyGroup || g === onlyGroup);
  const filledCount = fields.filter((f) => !isEmptySpec(custom[f.key] as SpecValue)).length;
  const suggest = () => {
    const s = suggestSpecs(fields, description, partNumber);
    const c = { ...custom } as Record<string, SpecValue>;
    const filled: string[] = [];
    for (const [k, v] of Object.entries(s)) if (isEmptySpec(c[k])) (c[k] = v, filled.push(fields.find((f) => f.key === k)?.label ?? k));
    if (!filled.length) return ui.toast("Nothing new found in the description");
    onChange(c as Custom);
    ui.toast(`Filled from the description: ${filled.join(", ")} — verify against the datasheet`);
  };
  const uploadCert = async (std: string, files: FileList | null) => {
    if (!partId || !files?.length) return;
    setBusy(std);
    try {
      for (const f of Array.from(files)) await api.parts.upload(partId, f, "Certificate", `${std} certificate`, `cert:${std}`);
      await loadDocs();
      onDocsChanged?.();
    } catch (e) {
      ui.toast(`Upload failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const input = (f: CustomFieldDef) => {
    const v = custom[f.key] as SpecValue | undefined;
    switch (f.type) {
      case "bool":
        return (
          <select value={v == null ? "" : v ? "1" : "0"} onChange={(e) => put(f.key, e.target.value === "" ? null : e.target.value === "1")}>
            <option value="">—</option><option value="1">Yes</option><option value="0">No</option>
          </select>
        );
      case "select":
        return (
          <select value={String(v ?? "")} onChange={(e) => put(f.key, e.target.value || null)}>
            <option value="">—</option>
            {[...new Set([...(f.options ?? []), ...(v != null && v !== "" ? [String(v)] : [])])].map((o) => <option key={o}>{o}</option>)}
          </select>
        );
      case "number":
        if (isC(f) && inF) {
          const c = typeof v === "number" ? v : null;
          return (
            <span className="tempf">
              <NumIn label={`${f.label} (°F)`} value={toF(c)} onChange={(x) => put(f.key, toC(x))} width={80} placeholder="°F" />
              <span className="muted cconv">= {c == null ? "—" : `${fmtC(c)} °C`}</span>
            </span>
          );
        }
        return <NumIn label={f.label} value={typeof v === "number" ? v : v == null ? null : Number(v)} onChange={(x) => put(f.key, x)} width={110} />;
      case "range": {
        const r = (Array.isArray(v) ? v : [null, null]) as [number | null, number | null];
        if (isC(f) && inF)
          return (
            <span className="tempf">
              <span className="rangein">
                <NumIn label={`${f.label} min (°F)`} value={toF(r[0])} onChange={(x) => put(f.key, [toC(x), r[1]])} width={64} placeholder="min °F" />
                <span>–</span>
                <NumIn label={`${f.label} max (°F)`} value={toF(r[1])} onChange={(x) => put(f.key, [r[0], toC(x)])} width={64} placeholder="max °F" />
              </span>
              <span className="muted cconv">= {r[0] == null && r[1] == null ? "—" : `${fmtC(r[0])} – ${fmtC(r[1])} °C`}</span>
            </span>
          );
        return (
          <span className="rangein">
            <NumIn label={`${f.label} min`} value={r[0]} onChange={(x) => put(f.key, [x, r[1]])} width={64} placeholder="min" />
            <span>–</span>
            <NumIn label={`${f.label} max`} value={r[1]} onChange={(x) => put(f.key, [r[0], x])} width={64} placeholder="max" />
          </span>
        );
      }
      case "multi": {
        const on = Array.isArray(v) ? (v as string[]) : [];
        return (
          <span className="bubbles">
            {(f.options ?? []).map((o) => (
              <button key={o} type="button" className="bubble" aria-pressed={on.includes(o)} onClick={() => put(f.key, on.includes(o) ? on.filter((x) => x !== o) : [...on, o])}>{o}</button>
            ))}
          </span>
        );
      }
      case "certs":
        return null;
      default:
        return <input type="text" value={String(v ?? "")} placeholder={f.help?.startsWith("e.g.") ? f.help : undefined} onChange={(e) => put(f.key, e.target.value)} />;
    }
  };

  const certsField = (f: CustomFieldDef) => {
    const on = Array.isArray(custom[f.key]) ? (custom[f.key] as string[]) : [];
    const all = [...new Set([...(f.options ?? []), ...on])];
    return (
      <div key={f.key} className="certs">
        <div className="bubbles">
          {all.map((o) => (
            <button key={o} type="button" className="bubble" aria-pressed={on.includes(o)} onClick={() => put(f.key, on.includes(o) ? on.filter((x) => x !== o) : [...on, o])}>
              {o}{docs.some((d) => d.ref === `cert:${o}`) ? " 📄" : ""}
            </button>
          ))}
          <button type="button" className="bubble edit" onClick={async () => {
            const s = await ui.prompt("Other certification / standard", "", "Add");
            if (s && !on.includes(s)) put(f.key, [...on, s]);
          }}>+ Other…</button>
        </div>
        {on.length > 0 && (
          <table className="mini wide certtab">
            <thead><tr><th>Certified to</th><th>Certificate</th><th /></tr></thead>
            <tbody>
              {on.map((std) => {
                const ds = docs.filter((d) => d.ref === `cert:${std}`);
                return (
                  <tr key={std}>
                    <td><b>{std}</b></td>
                    <td>
                      {ds.length ? ds.map((d) => (
                        <span key={d.id} className="certdoc">
                          <a href={d.fileName ? api.parts.docUrl(d.id, true) : d.url} target="_blank" rel="noreferrer noopener">{d.fileName || d.url}</a>
                          <ToSeriesBtn doc={d} series={partSeries ?? null} onMoved={() => (loadDocs(), onDocsChanged?.())} />
                          <PSeriesTag doc={d} onOpen={onSeries} />
                          <button type="button" className="btn-ghost btn-danger" aria-label="Remove certificate" disabled={!!d.seriesName}
                            title={d.seriesName ? "Product-series certificate: delete it from the product-series documents (hold the P-Series tag)" : undefined} onClick={async () => {
                            if (!(await ui.confirm(`Remove the ${std} certificate ${d.fileName || d.url}?`, "Remove"))) return;
                            await api.parts.removeDoc(d.id);
                            await loadDocs();
                            onDocsChanged?.();
                          }}>✕</button>
                        </span>
                      )) : <span className="muted">{partId ? "No certificate attached" : "Save the part to attach certificates"}</span>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {partId && (
                        <>
                          <label className="btn btn-ghost">
                            {busy === std ? "Uploading…" : "Attach PDF…"}
                            <input type="file" accept=".pdf,.png,.jpg,.jpeg" multiple disabled={!!busy} onChange={(e) => (uploadCert(std, e.target.files), (e.target.value = ""))} />
                          </label>
                          <button type="button" className="btn-ghost" onClick={async () => {
                            const url = await ui.prompt(`Link to the ${std} certificate (e.g. UL Product iQ / CSA directory page)`, "https://", "Add link");
                            if (!url || !/^https?:\/\//i.test(url)) return;
                            await api.parts.addLink(partId, { kind: "Certificate", title: `${std} certificate`, url, ref: `cert:${std}` });
                            await loadDocs();
                            onDocsChanged?.();
                          }}>Link…</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  if (!fields.length) return null;
  return (
    <div className="specs">
      <div className="toolbar">
        <span className="muted" style={{ fontSize: 12.5 }}>{filledCount} of {fields.length} specified</span>
        <button type="button" onClick={suggest} title="Read values written in the description (poles, curve, amps, voltage range…); only empty fields are filled">Fill from description</button>
        {fields.some((f) => isC(f) && (!onlyGroup || (f.group || "Specifications") === onlyGroup)) && (
          <label className="switch" title="Type temperatures in °F; they are converted and stored in °C">
            <input type="checkbox" role="switch" aria-label="Enter temperatures in °F" checked={inF} onChange={(e) => setInF(e.target.checked)} /> Enter in °F
          </label>
        )}
      </div>
      {groups.map((g) => (
        <div key={g} className="specgrp">
          {!onlyGroup && <h4>{g}</h4>}
          <div className="specgrid">
            {fields.filter((f) => (f.group || "Specifications") === g).map((f) =>
              f.type === "certs" ? (
                <div key={f.key} className="f span-all" title={f.help}><span>{f.label}</span>{certsField(f)}</div>
              ) : (
                <label key={f.key} className={`f${f.type === "multi" ? " span-all" : ""}`} title={f.help}>
                  <span>{f.label}{f.unit ? <span className="muted"> ({isC(f) && inF ? "°F → °C" : f.unit})</span> : null}{f.help ? <span className="hint" aria-hidden="true"> ⓘ</span> : null}</span>
                  {input(f)}
                </label>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Read-only text of a spec for tables. */
export const specCell = (f: CustomFieldDef, p: Pick<Part, "custom">) => specText(f, p.custom?.[f.key] as SpecValue | undefined);
