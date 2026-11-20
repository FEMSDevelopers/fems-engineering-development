import { CERT_TYPE_REF, DEFAULT_CERT_TYPES, aliasOf, certTypeOf, type PartDoc } from "@fpl/core";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../api";
import { HoldButton, Modal, useHold, useUi } from "../ui";
import { useMfrAliases } from "./aliases";
import { canPreview, docStdNames, downloadDoc, downloadDocsZip } from "./docFiles";
import { useEditPartStandard } from "./Naming";
import { TextIn } from "./shared";
import { DocHoverPreview } from "./DocPreview";
import { PSeriesTag, ToSeriesBtn, type SeriesRef } from "./seriesUi";

/** Certificate types (shared by every project, editable): Environment, General product approval, Test Certificates… */
const SCOPE = "bom.cert-types";
const EVT = "fpl:cert-types";
export function useCertTypes() {
  const [types, setTypes] = useState<string[]>(DEFAULT_CERT_TYPES);
  const load = useCallback(() => {
    api.presets.list<{ types: string[] }>(SCOPE).then((l) => {
      const t = l.find((x) => x.name === "default")?.data.types;
      setTypes(t?.length ? t : DEFAULT_CERT_TYPES);
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(EVT, load);
    return () => window.removeEventListener(EVT, load);
  }, [load]);
  return { types, reload: load };
}
async function saveTypes(types: string[]) {
  await api.presets.save(SCOPE, "default", { types });
  window.dispatchEvent(new Event(EVT));
}

/** Add / rename / reorder / delete certificate types; a rename re-files every certificate of that type (all parts). */
export function CertTypesModal({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const { types } = useCertTypes();
  const [rows, setRows] = useState<{ from: string; name: string }[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!rows) setRows(types.map((t) => ({ from: t, name: t })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types]);
  useEffect(() => {
    api.parts.certTypeCounts().then(setCounts).catch(() => undefined);
  }, []);
  const list = rows ?? [];
  const names = list.map((r) => r.name.trim());
  const dup = names.find((n, i) => n && names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const n = list.slice();
    [n[i], n[j]] = [n[j], n[i]];
    setRows(n);
  };
  const save = async () => {
    setBusy(true);
    try {
      let moved = 0;
      for (const r of list) if (r.from && r.name.trim() && r.from !== r.name.trim()) moved += (await api.parts.certTypeRename(r.from, r.name.trim())).updated;
      await saveTypes(names.filter(Boolean));
      ui.toast(`Certificate types saved${moved ? ` · ${moved} certificate${moved === 1 ? "" : "s"} re-filed` : ""}`);
      onClose();
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Certificate types">
      <div className="mh"><h3>Certificate types</h3><span className="muted" style={{ fontSize: 12.5 }}>Shared by every part and project. Datasheet certificate links are filed under the type matching the heading of their column.</span></div>
      <div className="mb">
        <table className="mini">
          <thead><tr><th>#</th><th>Type</th><th title="Certificates filed under this type (all parts)">Certificates</th><th /></tr></thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={i}>
                <td className="mono muted">{i + 1}</td>
                <td>
                  <TextIn label={`Certificate type ${i + 1}`} value={r.name} width={240} onChange={(v) => setRows(list.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
                  {r.from && r.from !== r.name.trim() && r.name.trim() && <span className="muted" style={{ fontSize: 11 }}> (was {r.from})</span>}
                </td>
                <td className="num muted">{r.from ? counts[r.from] ?? 0 : "new"}</td>
                <td>
                  <button type="button" className="btn-ghost" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="btn-ghost" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <HoldButton ms={500} className="btn-ghost btn-danger" label={`Delete type ${r.name}`} onHold={() => setRows(list.filter((_, j) => j !== i))}>✕</HoldButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {dup && <p className="errtxt" style={{ margin: 0 }}>“{dup}” is listed twice.</p>}
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Deleting a type keeps its certificates (shown with their old type until you change it). Renaming re-files them.</p>
      </div>
      <div className="mf">
        <button type="button" onClick={() => setRows([...list, { from: "", name: "" }])}>+ Type</button>
        <button type="button" className="btn-ghost" onClick={() => setRows(DEFAULT_CERT_TYPES.map((t) => ({ from: list.find((x) => x.name === t)?.from ?? "", name: t })))}>Defaults</button>
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !!dup || !names.filter(Boolean).length} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

export const isCertDoc = (x: PartDoc) => isCert(x);
const isCert = (x: PartDoc) => x.kind === "Certificate" || x.ref?.startsWith(CERT_TYPE_REF) || x.ref?.startsWith("cert:");

/**
 * Certificates of a part (Documentation tab): every certificate document or link with its type, an Active column (an
 * inactive certificate is left out of the documentation package; all are active by default), title, file / link.
 */
export function CertificateList({ partId, nonce, onChanged, series, partSeries, onSeries, part, sub }: {
  partId: string; nonce?: number; onChanged?: () => void;
  /** Part (product-series mode: a part of the series, the series as its part number) and subcategory, for standard file names. */
  part?: { manufacturer: string; partNumber: string; series: string }; sub?: string;
  /** Product-series mode: the certificates of this manufacturer + product series (shared by every part of the series). */
  series?: { mfr: string; series: string };
  /** Part mode: the saved part's product series (⏫ moves a certificate to it), and opening the product-series documents. */
  partSeries?: SeriesRef; onSeries?: () => void;
}) {
  const ui = useUi();
  const { types } = useCertTypes();
  const [docs, setDocs] = useState<PartDoc[]>([]);
  const [typesDlg, setTypesDlg] = useState(false);
  const [add, setAdd] = useState<{ type: string; name: string; title: string; url: string }>({ type: "", name: "", title: "", url: "" });
  const [busy, setBusy] = useState(false);
  const sm = series?.mfr, ss = series?.series;
  const load = useCallback(() => (sm && ss ? api.parts.seriesDocs(sm, ss) : api.parts.docs(partId)).then(setDocs).catch((e) => ui.toast(errMsg(e))), [partId, ui, sm, ss]);
  const partMode = !series;
  useEffect(() => {
    load();
  }, [load, nonce]);
  const certs = docs.filter(isCert);
  // Standard names (downloads: files and .url link files), as in Documents.
  const editStd = useEditPartStandard();
  const aliases = useMfrAliases();
  const pp = part ?? { manufacturer: "", partNumber: "", series: "" };
  const names = docStdNames(editStd.std, certs, { ...pp, mfrAlias: aliasOf(aliases, pp.manufacturer) }, sub, !!series);
  const dlAll = useHold(400, () => {
    const name = `${[pp.manufacturer, series ? series.series : pp.partNumber].filter(Boolean).join(" ")} certificates`;
    downloadDocsZip(name, certs, names, undefined, name).catch((e) => ui.toast(errMsg(e)));
  });
  const type = add.type || types[0] || "Other";
  const upd = async (x: PartDoc, b: { active?: boolean; ref?: string; title?: string; approvalId?: string; certName?: string; url?: string }) => {
    setDocs((l) => l.map((d) => (d.id === x.id ? { ...d, ...b } : d)));
    try {
      await api.parts.updateDoc(x.id, b);
      onChanged?.();
    } catch (e) {
      ui.toast(errMsg(e));
      load();
    }
  };
  const typeLabel = (x: PartDoc) => certTypeOf(x.ref) || (x.ref?.startsWith("cert:") ? `Standard · ${x.ref.slice(5)}` : "");
  return (
    <div className="certlist">
      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Certificates ({certs.length})</b>
        <span className="muted" style={{ fontSize: 12 }}>{certs.filter((c) => c.active === false).length ? `${certs.filter((c) => c.active === false).length} inactive — left out of the documentation package` : "All active"}</span>
        <span className="grow" />
        <button type="button" className="btn-ghost" onClick={() => setTypesDlg(true)}>Certificate types…</button>
      </div>
      {certs.length > 0 && (
        <table className="net doctab certtab">
          <thead><tr><th title="Active certificates go into outputs (documentation package and its index)">Active</th><th>Type</th><th title="Name of the certificate, e.g. Environmental Confirmation, UL Listing, CB Test Certificate">Certificate name</th><th>Title</th><th title="Approval ID of each certificate (UL file number, CSA master contract, certificate number…)">Approval ID</th><th title="Stored certificate file (PDFs / images: click to open, hover to preview)">File</th><th title="Web page of the certificate (approval database, declaration…); click ↗ to open it in a new tab">Link</th><th className="dl hcol" {...dlAll} title="Download the file (links: a .url link file). Click and hold 0.4 s: download every certificate (zip with an index)">💾</th>{partMode && <th className="dl" title="Move to the product series of the part (hold 0.5 s): listed under every part of the same manufacturer and product series">⏫</th>}<th />{partMode && <th title="Product-series certificates (shared by every part of the series); hold the tag 0.3 s to open them" />}</tr></thead>
          <tbody>
            {certs.map((x) => {
              const t = typeLabel(x);
              return (
                <tr key={x.id} className={[x.active === false && "inactive", partMode && x.seriesName && "pseries"].filter(Boolean).join(" ") || undefined}>
                  <td className="chk"><input type="checkbox" aria-label={`Active: ${x.title}`} checked={x.active !== false} onChange={(e) => upd(x, { active: e.target.checked })} /></td>
                  <td>
                    <select aria-label={`Type of ${x.title}`} value={certTypeOf(x.ref) || (t ? `__${t}` : "")} onChange={(e) => upd(x, { ref: `${CERT_TYPE_REF}${e.target.value}` })}>
                      {!certTypeOf(x.ref) && <option value={t ? `__${t}` : ""} disabled>{t || "— (no type)"}</option>}
                      {[...new Set([...types, ...(certTypeOf(x.ref) ? [certTypeOf(x.ref)] : [])])].map((k) => <option key={k} value={k}>{k}{types.includes(k) ? "" : " (deleted type)"}</option>)}
                    </select>
                  </td>
                  <td><TextIn label={`Certificate name of ${x.title}`} value={x.certName ?? ""} width="100%" placeholder="e.g. UL Listing" onChange={(v) => upd(x, { certName: v.trim() })} /></td>
                  <td><TextIn label={`Title of ${x.title}`} value={x.title} width="100%" onChange={(v) => upd(x, { title: v })} /></td>
                  <td className="apprid" title={`Approval ID of “${x.title}”${t ? ` (${t})` : ""}`}>
                    <TextIn label={`Approval ID of ${x.title}`} value={x.approvalId ?? ""} mono width={150} placeholder="e.g. E123456" onChange={(v) => upd(x, { approvalId: v.trim() })} />
                  </td>
                  <td className="clipc">
                    {x.fileName
                      ? canPreview(x)
                        ? <DocHoverPreview doc={x}><a href={api.parts.docUrl(x.id, true)} target="_blank" rel="noreferrer">{x.fileName}</a></DocHoverPreview>
                        : <span className="plainfile" title="No preview for this file type — download it with 💾">{x.fileName}</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="certlink">
                    <span className="certlinkin">
                      <TextIn label={`Link of ${x.title}`} value={x.url} mono width="100%" placeholder="https://…" onChange={(v) => {
                        const u = v.trim();
                        if (u && !/^https?:\/\/\S+$/i.test(u)) return ui.toast("Link: a web address starting with http:// or https://");
                        if (!u && !x.fileName) return ui.toast("A link certificate needs its link (delete the certificate instead)");
                        void upd(x, { url: u });
                      }} />
                      {x.url && <a className="btn-ghost" href={x.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${x.url}`} title={`Open ${x.url} in a new tab`}>↗</a>}
                    </span>
                  </td>
                  <td className="dl">
                    <button type="button" className="btn-ghost dlbtn" aria-label={`Download ${names.get(x.id) ?? x.title}`} title={x.fileName ? `Download ${x.fileName}` : `Download a link file (${names.get(x.id)}) that opens ${x.url}`} onClick={() => downloadDoc(x, names.get(x.id))}>💾</button>
                  </td>
                  {partMode && <td className="dl"><ToSeriesBtn doc={x} series={partSeries ?? null} onMoved={() => (onChanged?.(), load())} /></td>}
                  <td>
                    <HoldButton ms={500} className="btn-ghost btn-danger" label={`Remove certificate ${x.title}`} disabled={partMode && !!x.seriesName}
                      title={partMode && x.seriesName ? "Product-series certificate: delete it from the product-series documents (hold the P-Series tag)" : undefined} onHold={async () => {
                      setDocs((l) => l.filter((d) => d.id !== x.id));
                      await api.parts.removeDoc(x.id).catch((e) => ui.toast(errMsg(e)));
                      onChanged?.();
                      load();
                    }}>✕</HoldButton>
                  </td>
                  {partMode && <td><PSeriesTag doc={x} onOpen={onSeries} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="frow tight">
        <label className="f">Type<select value={type} onChange={(e) => setAdd({ ...add, type: e.target.value })}>{types.map((k) => <option key={k}>{k}</option>)}</select></label>
        <label className="f">Certificate name<input type="text" value={add.name} placeholder="e.g. UL Listing" onChange={(e) => setAdd({ ...add, name: e.target.value })} style={{ width: 170 }} /></label>
        <label className="f">Title<input type="text" value={add.title} placeholder={`${type} certificate`} onChange={(e) => setAdd({ ...add, title: e.target.value })} style={{ width: 200 }} /></label>
        <label className="f" style={{ flex: 1 }}>Link (URL)<input type="url" value={add.url} placeholder="https://…" onChange={(e) => setAdd({ ...add, url: e.target.value })} /></label>
        <button type="button" style={{ alignSelf: "flex-end" }} disabled={busy || !/^https?:\/\/\S+$/.test(add.url.trim())} onClick={async () => {
          setBusy(true);
          try {
            const b = { kind: "Certificate", title: add.title.trim() || `${type} certificate`, url: add.url.trim(), ref: `${CERT_TYPE_REF}${type}`, certName: add.name.trim() };
            if (series) await api.parts.seriesAddLink(series.mfr, series.series, b);
            else await api.parts.addLink(partId, b);
            setAdd({ ...add, name: "", title: "", url: "" });
            onChanged?.();
            load();
          } catch (e) {
            ui.toast(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}>Add link</button>
        <label className="btn" style={{ alignSelf: "flex-end" }}>
          {busy ? "…" : "Upload file(s)…"}
          <input type="file" multiple disabled={busy} onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!files.length) return;
            setBusy(true);
            try {
              for (const f of files) {
                const doc = series
                  ? await api.parts.seriesUpload(series.mfr, series.series, f, "Certificate", add.title.trim() || f.name, `${CERT_TYPE_REF}${type}`)
                  : await api.parts.upload(partId, f, "Certificate", add.title.trim() || f.name, `${CERT_TYPE_REF}${type}`);
                if (add.name.trim()) await api.parts.updateDoc(doc.id, { certName: add.name.trim() });
              }
              onChanged?.();
              load();
            } catch (er) {
              ui.toast(errMsg(er));
            } finally {
              setBusy(false);
            }
          }} />
        </label>
      </div>
      {typesDlg && <CertTypesModal onClose={() => setTypesDlg(false)} />}
    </div>
  );
}
