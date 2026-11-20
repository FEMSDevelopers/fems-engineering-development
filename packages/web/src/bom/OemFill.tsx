import { CERT_TYPE_REF, certFields, certLinksFromPdf, certTitle, type CertLink, type PdfPageData, applyHits, catalogRowText, currentOf, emptyPowerIn, extractPartData, findCatalogRows, retarget, scrapeTargets, targetKey, type ScrapeTarget, type Subcategory, type CustomFieldDef, type Part, type PartDoc, type PageText, type ScrapeHit } from "@fpl/core";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { useUi } from "../ui";
import { Modal } from "../ui";
import { useCertTypes } from "./Certs";
import { PdfPagesPreview, type PageMarks } from "./DocPreview";

/** PDF → text with table-ish rows kept as "label: value | value" lines. */
export async function pdfText(data: Uint8Array, maxPages = 12): Promise<string> {
  return (await readPdf(data, maxPages)).text;
}
/** Where each text line came from: its page (1-based) and the text boxes [x, y, w, h] of the line on that page. */
export interface PdfLine { page: number; boxes: number[][] }
/** PDF → text (as pdfText) and, per page, the text items and link annotations (certificate links); `lines` maps every text line to its page. */
export async function readPdf(data: Uint8Array, maxPages = 12): Promise<{ text: string; pages: PdfPageData[]; lines: PdfLine[] }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const out: string[] = [];
  const lines: PdfLine[] = [];
  const pages: PdfPageData[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const an = (await pg.getAnnotations().catch(() => [])) as { subtype?: string; url?: string; rect?: number[] }[];
    pages.push({
      h: pg.getViewport({ scale: 1 }).height,
      items: (tc.items as { str: string; transform: number[]; width: number }[]).filter((t) => t.str?.trim()).map((t) => ({ s: t.str, x: t.transform[4], y: t.transform[5], w: t.width })),
      links: an.filter((a) => a.subtype === "Link" && a.url && a.rect).map((a) => ({ url: a.url!, rect: a.rect! })),
    });
    const rows = new Map<number, { x: number; w: number; s: string; y: number; h: number }[]>();
    for (const it of tc.items as { str: string; transform: number[]; width: number; height?: number }[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 2.5);
      (rows.get(y) ?? rows.set(y, []).get(y)!).push({ x: it.transform[4], w: it.width, s: it.str.trim(), y: it.transform[5], h: it.height || Math.abs(it.transform[3]) || 8 });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const cells: string[] = [];
      let last = -1e9;
      for (const c of rows.get(y)!.sort((a, b) => a.x - b.x)) {
        if (cells.length && c.x - last < 12) cells[cells.length - 1] += ` ${c.s}`;
        else cells.push(c.s);
        last = c.x + c.w;
      }
      out.push(cells.length >= 2 ? `${cells[0]}: ${cells.slice(1).join(" | ")}` : cells[0]);
      lines.push({ page: i, boxes: rows.get(y)!.map((c) => [c.x, c.y, c.w, c.h]) });
    }
  }
  void task.destroy();
  return { text: out.join("\n"), pages, lines };
}
/** 🎞️: hover to preview the PDF page(s) a value / table row was read from, with the source text highlighted. */
function Film({ pdf, s, label }: { pdf: { data: Uint8Array; name: string } | null; s: { pageNos: number[]; marks: PageMarks } | null; label: string }) {
  return s && pdf ? (
    <PdfPagesPreview data={pdf.data} title={`${pdf.name} — ${label}`} pageNos={s.pageNos} marks={s.marks}>
      <span className="filmic" tabIndex={0} aria-label={`Preview page ${s.pageNos.join(", ")} (${label})`}>🎞️</span>
    </PdfPagesPreview>
  ) : <span className="muted">—</span>;
}
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

type Draft = Omit<Part, "id"> & { id?: string };
const show = (v: unknown) => (v == null || v === "" ? "" : Array.isArray(v) ? (v.length === 2 && typeof v[0] !== "string" ? `${v[0] ?? ""}–${v[1] ?? ""}` : v.join(", ")) : typeof v === "object" ? JSON.stringify(v) : String(v));

/** "Fill from OEM page / datasheet": read a product page, a datasheet link, a stored datasheet or a PDF file; review every value before it is applied. */
export function OemFill({ d, fields, onApply, onClose, parts = [], subcats = [], onPartsSaved, onDocsChanged }: {
  d: Draft; fields: CustomFieldDef[]; onApply: (p: Draft) => void; onClose: () => void;
  /** Certificate links were added to the part's documents. */
  onDocsChanged?: () => void;
  /** Master parts and subcategories (apply the same selection to a manufacturer / subcategory / series). */
  parts?: Part[]; subcats?: Subcategory[]; onPartsSaved?: (p: Part[]) => void;
}) {
  const ui = useUi();
  const [remap, setRemap] = useState<Record<number, ScrapeTarget>>({});
  const [bulk, setBulk] = useState(false);
  const [scope, setScope] = useState<"series" | "sub" | "mfr">("series");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const targets = useMemo(() => scrapeTargets(fields), [fields]);
  const [url, setUrl] = useState("");
  const [docs, setDocs] = useState<PartDoc[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [src, setSrc] = useState("");
  const [hits, setHits] = useState<ScrapeHit[] | null>(null);
  const [on, setOn] = useState<Set<number>>(new Set());
  const [pdfLinks, setPdfLinks] = useState<string[]>([]);
  // Certificate links found in the datasheet PDF (iDS), with the type / title / tick chosen for each.
  const certTypes = useCertTypes().types;
  const [certs, setCerts] = useState<(CertLink & { certName: string; title: string; approvalId: string; on: boolean })[]>([]);
  const [certBusy, setCertBusy] = useState(false);
  // The PDF being read (kept to preview the pages the values come from) and the page of each of its text lines.
  const [pdf, setPdf] = useState<{ data: Uint8Array; lines: PdfLine[]; name: string } | null>(null);
  const pdfRead = async (data: Uint8Array, name = "PDF"): Promise<PageText> => {
    const keep = data.slice();
    const r = await readPdf(data, pages);
    setPdf({ data: keep, lines: r.lines, name });
    const stored = new Set(docs.map((x) => x.url).filter(Boolean));
    // Each found certificate → its fields: type (column heading), certificate name (cell text), title (heading), link, approval ID.
    setCerts(certLinksFromPdf(r.pages, certTypes).map((c, i, l) => {
      const logos = l.filter((x) => !x.label && x.type === c.type);
      return { ...c, ...certFields(c, logos.length > 1 ? logos.indexOf(c) + 1 : undefined), on: !stored.has(c.url) };
    }));
    return { title: "", text: r.text, product: {} };
  };
  const [mode, setMode] = useState<"ids" | "catalog">("ids");
  const [page, setPage] = useState<PageText | null>(null);
  const [findPn, setFindPn] = useState(d.partNumber);
  const [rowIdx, setRowIdx] = useState(0);
  const pages = mode === "catalog" ? 80 : 12;
  const rows = useMemo(() => (mode === "catalog" && page ? findCatalogRows(page.text, findPn) : []), [mode, page, findPn]);
  // Values from the source: the whole page (iDS) or the selected table row (catalog / flyer).
  useEffect(() => {
    if (!page) return;
    if (mode === "catalog" && !rows.length) {
      setHits([]);
      setOn(new Set());
      setErr(`“${findPn}” was not found in a table row of ${src || "this source"}. Try the SKU / order code, or read it as an individual datasheet.`);
      return;
    }
    const pg = mode === "catalog" ? catalogRowText(rows[Math.min(rowIdx, rows.length - 1)]) : page;
    const h = extractPartData(pg, d, fields);
    setHits(h);
    setRemap({});
    // Pre-tick values for empty fields; changes to filled fields are opt-in.
    setOn(new Set(h.map((x, i) => [x, i] as const).filter(([x]) => { if (x.weak) return false; const c = currentOf(d, x.target); return c == null || c === "" || (Array.isArray(c) && !c.length); }).map(([, i]) => i)));
    setErr(h.length ? "" : "Nothing recognisable found on that source.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, mode, rows, rowIdx]);
  useEffect(() => {
    if (d.id) api.parts.docs(d.id).then(setDocs).catch(() => {});
  }, [d.id]);
  const eff = useMemo(() => (hits ?? []).map((h, i) => (remap[i] ? retarget(h, remap[i], fields) : h)), [hits, remap, fields]);
  /** The selection: which values (by the field they were found as) go to which field. */
  const selection = useMemo(() => [...on].filter((i) => hits?.[i]).map((i) => ({ from: targetKey(hits![i].target), to: eff[i].target })), [on, hits, eff]);
  const subOf = (p: { subcategoryId?: string | null }) => subcats.find((x) => x.id === p.subcategoryId)?.name ?? "";
  const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  const scopeParts = useMemo(() => parts.filter((p) => p.id !== d.id && same(p.manufacturer, d.manufacturer) && (scope === "mfr" || p.subcategoryId === d.subcategoryId) && (scope !== "series" || same(p.series, d.series))), [parts, d, scope]);
  /** What the same selection gives for each part of the scope (catalog: its own table row). */
  const plan = useMemo(() => {
    if (!bulk || !page) return [];
    return scopeParts.map((p) => {
      let pg: PageText | null = page;
      let row = "";
      if (mode === "catalog") {
        const r = findCatalogRows(page.text, p.partNumber);
        const r2 = r.length ? r : p.sku ? findCatalogRows(page.text, p.sku) : [];
        pg = r2.length ? catalogRowText(r2[0]) : null;
        row = r2.length ? r2[0].cells.slice(0, 4).join(" · ") : "";
      }
      const hs = pg ? extractPartData(pg, p, fields) : [];
      const vals = selection.flatMap((s) => {
        const h = hs.find((x) => targetKey(x.target) === s.from);
        return h ? [targetKey(h.target) === targetKey(s.to) ? h : retarget(h, s.to, fields)] : [];
      });
      return { p, row, vals };
    });
  }, [bulk, page, scopeParts, mode, selection, fields]);
  const q = encodeURIComponent([d.manufacturer, d.partNumber, "datasheet"].filter(Boolean).join(" "));
  // "Ask Claude ↗": a new Claude chat with the request prefilled (you send it; Claude asks you for browser access).
  const blocked = /\b(403|401|429|forbidden|blocked|denied)\b/i.test(err);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const claudePrompt = [
    `Open this product page in my browser and read it: ${url || `(find the product page of ${[d.manufacturer, d.partNumber].filter(Boolean).join(" ")})`}`,
    `Part: ${[d.manufacturer, d.partNumber].filter(Boolean).join(" ")}${d.sku ? ` (SKU ${d.sku})` : ""}.`,
    "Reply in plain text only, one value per line as \"Label: value\" with units as printed: description, product series, order number / SKU, dimensions (width, height, depth), net weight, mounting, input voltage / range / frequency / current, output voltage / current / power, efficiency, operating and storage temperature, protection class, approvals / certifications (name, number and link), and every technical data row of the page.",
    "Then list every PDF link on the page (datasheet, manual, certificates), one per line.",
  ].join("\n");
  const claudeHref = `https://claude.ai/new?q=${encodeURIComponent(claudePrompt)}`;
  // Page of the PDF each value / table row was read from (🎞️ previews it with the source text highlighted).
  const textLines = useMemo(() => (pdf && page ? page.text.split("\n") : []), [pdf, page]);
  const lineOf = (from: string): number => {
    const f = from.trim();
    if (f.length < 3 || !textLines.length) return -1;
    const k = f.slice(0, 80);
    const i = textLines.findIndex((l) => l.includes(k));
    return i >= 0 ? i : textLines.findIndex((l) => l.trim().length >= 6 && f.includes(l.trim()));
  };
  const srcAt = (idx: number[]): { pageNos: number[]; marks: PageMarks } | null => {
    const ls = idx.filter((i) => i >= 0 && pdf?.lines[i]).map((i) => pdf!.lines[i]);
    if (!ls.length) return null;
    const marks: PageMarks = {};
    for (const l of ls) (marks[l.page] ??= []).push(...l.boxes);
    return { pageNos: [...new Set(ls.map((l) => l.page))].sort((a, b) => a - b), marks };
  };
  const rowSrc = (r: { at: number }) => srcAt([r.at]);
  const hitSrc = (h: ScrapeHit) => (mode === "catalog" ? (rows.length ? rowSrc(rows[Math.min(rowIdx, rows.length - 1)]) : null) : srcAt([lineOf(h.from)]));


  const read = async (label: string, f: () => Promise<PageText>) => {
    setBusy(label);
    setErr("");
    try {
      const pg = await f();
      setSrc(label);
      setRowIdx(0);
      setPage(pg);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
    }
  };
  const fromUrl = (u: string) =>
    read(u, async () => {
      const r = await api.parts.scrape(u);
      if (r.kind === "pdf") return pdfRead(b64(r.pdf), decodeURIComponent(u.split("/").pop()!.split("?")[0]) || "PDF");
      setPdf(null);
      setCerts([]);
      setPdfLinks(r.pdfLinks);
      return { title: r.title, text: r.text, product: r.product };
    });
  const fromDoc = (doc: PartDoc) =>
    doc.size > 0 && /pdf/i.test(doc.mime || doc.fileName)
      ? read(doc.title || doc.fileName || "datasheet", async () => {
          const buf = new Uint8Array(await (await fetch(api.parts.docUrl(doc.id))).arrayBuffer());
          return pdfRead(buf, doc.fileName || doc.title || "datasheet");
        })
      : doc.url
        ? fromUrl(doc.url)
        : Promise.resolve();

  return (
    <Modal onClose={onClose} label="Fill from OEM page or datasheet">
      <div className="mh"><h3>Fill from OEM page / datasheet</h3><span className="muted mono">{[d.manufacturer, d.partNumber].filter(Boolean).join(" · ")}</span></div>
      <div className="mb">
        <div className="frow tight" style={{ alignItems: "flex-end" }}>
          <div className="seg" role="group" aria-label="Source type">
            <button type="button" aria-pressed={mode === "ids"} onClick={() => setMode("ids")} title="Product page or datasheet of this one part number (iDS)">Individual datasheet (iDS)</button>
            <button type="button" aria-pressed={mode === "catalog"} onClick={() => setMode("catalog")} title="Catalog or flyer with a table of part numbers: the row of this part is paired with the column headers; long text cells are read too">Catalog / flyer table</button>
          </div>
          {mode === "catalog" && <label className="f">Find the row of<input type="text" className="mono" value={findPn} onChange={(e) => setFindPn(e.target.value)} style={{ width: 200 }} title="Part number, SKU or order code as printed in the catalog" /></label>}
          {mode === "catalog" && (d.sku || "") && d.sku !== findPn && <button type="button" className="btn-ghost" onClick={() => setFindPn(d.sku!)}>Use SKU {d.sku}</button>}
        </div>
        <div className="frow tight">
          <label className="f" style={{ flex: 1 }}>{mode === "catalog" ? "Catalog / flyer link (PDF or page)" : "Product page or datasheet link"}
            <input type="url" value={url} placeholder="https://www.phoenixcontact.com/…/2904601" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && url && fromUrl(url)} />
          </label>
          <button type="button" className="btn-primary" disabled={!url || !!busy} onClick={() => fromUrl(url)}>Read</button>
          <a className="btn" href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noreferrer" title="Opens a web search in a new tab; paste the OEM page link here">Search the web ↗</a>
          {/* Pages that refuse the server (403, bot protection): Claude reads them in your own browser session — you grant the browser access in Claude — and its answer is pasted back below. */}
          <a className={`btn${blocked ? " btn-primary" : ""}`} href={claudeHref} target="_blank" rel="noreferrer"
            title="Opens Claude in a new tab with a request to read this page in your browser (Claude in Chrome — you grant the access) and answer with its data as “Label: value” lines; paste the answer with “Paste page text…”">Ask Claude ↗</a>
          <button type="button" aria-pressed={pasteOpen} onClick={() => setPasteOpen((v) => !v)} title="Paste the text of a page (Claude's answer, or the page itself: Ctrl+A, Ctrl+C) to read its values">Paste page text…</button>
          <label className="btn">Read a PDF…<input type="file" accept=".pdf" onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) read(f.name, async () => pdfRead(new Uint8Array(await f.arrayBuffer()), f.name));
          }} /></label>
        </div>
        {(docs.some((x) => (x.size > 0 && /pdf/i.test(x.mime || x.fileName)) || x.url) || pdfLinks.length > 0) && (
          <div className="bubbles">
            {docs.filter((x) => (x.size > 0 && /pdf/i.test(x.mime || x.fileName)) || x.url).map((x) => <button key={x.id} type="button" className="bubble" disabled={!!busy} onClick={() => fromDoc(x)} title={x.size > 0 ? "Stored file" : x.url}>{x.kind}: {x.title || x.fileName || x.url}</button>)}
            {pdfLinks.map((l) => <button key={l} type="button" className="bubble" disabled={!!busy} onClick={() => fromUrl(l)} title={l}>PDF on page: {decodeURIComponent(l.split("/").pop()!.split("?")[0]).slice(0, 48)}</button>)}
          </div>
        )}
        {busy && <p className="muted" style={{ margin: 0 }}>Reading {busy}…</p>}
        {mode === "catalog" && rows.length > 0 && (
          <div className="catrows">
            <span className="muted" style={{ fontSize: 12.5 }}>{rows.length} table row{rows.length > 1 ? "s" : ""} with “{findPn}” — values come from the selected row and its column headers{rows.length > 1 ? "; pick the right one" : ""}:</span>
            {rows.slice(0, 8).map((r, i) => (
              <label key={r.at} className={`catrow${i === rowIdx ? " sel" : ""}`}>
                <input type="radio" name="catrow" checked={i === rowIdx} onChange={() => setRowIdx(i)} />
                {pdf && <span className="catpage" onClick={(e) => e.preventDefault()}><Film pdf={pdf} s={rowSrc(r)} label={`table row ${i + 1}`} /><span className="muted">p. {rowSrc(r)?.pageNos.join(", ") ?? "—"}</span></span>}
                <table className="mini">
                  {r.headers && <thead><tr>{r.headers.map((h, k) => <th key={k}>{h}</th>)}</tr></thead>}
                  <tbody><tr>{r.cells.map((c, k) => <td key={k} className={c.length > 40 ? "longcell" : undefined}>{c}</td>)}</tr></tbody>
                </table>
              </label>
            ))}
          </div>
        )}
        {err && <p className="errtxt" style={{ margin: 0 }}>{err}{blocked && <> — the site refuses automated reads: use <b>Ask Claude ↗</b> (reads it in your browser, with your permission) or open the page and <b>Paste page text…</b></>}</p>}
        {pasteOpen && (
          <div className="pastebox">
            <textarea rows={6} aria-label="Pasted page text" value={pasted} placeholder={"Paste Claude's answer or the page text here, e.g.\nDimensions: 70 x 130 x 125 mm\nWeight: 1.2 kg\nInput voltage range: 85 V AC ... 264 V AC"} onChange={(e) => setPasted(e.target.value)} />
            <div className="toolbar">
              <button type="button" className="btn-primary" disabled={!pasted.trim() || !!busy} onClick={() => {
                const text = pasted.replace(/\r/g, "");
                // PDF links in the pasted text (datasheets) become buttons to read them.
                setPdfLinks([...new Set(text.match(/https?:\/\/[^\s"'<>)]+\.pdf\b[^\s"'<>)]*/gi) ?? [])]);
                read(url ? `pasted text of ${url}` : "pasted text", async () => (setPdf(null), setCerts([]), { title: "", text, product: {} }));
              }}>Read pasted text</button>
              <span className="muted" style={{ fontSize: 12 }}>One value per line reads best (“Label: value”). PDF links in the text are offered to read.</span>
            </div>
          </div>
        )}
        {hits && hits.length > 0 && (
          <>
            <div className="descbox">
              <div><span className="muted">Description of </span><b className="mono">{d.partNumber}</b>: {d.description || <span className="muted">(empty)</span>}
                {eff.some((h) => h.target.kind === "part" && h.target.key === "description") && <> → <b>{show(eff.find((h) => h.target.kind === "part" && h.target.key === "description")!.value)}</b></>}</div>
              {eff.some((h) => h.target.kind === "part" && h.target.key === "oemDesc") && <div className="oemd"><span className="muted">OEM desc (long text, stored apart): </span>{show(eff.find((h) => h.target.kind === "part" && h.target.key === "oemDesc")!.value).slice(0, 400)}</div>}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>From <b>{src}</b>. Ticked values are applied to the editor (save the part afterwards). Values for fields that already have a value are not ticked. Change “Store in field” when a value was allocated to the wrong field.</p>
            <div className="scroll" style={{ maxHeight: "48vh" }}>
              <table className="mini wide">
                <thead><tr><th><input type="checkbox" aria-label="All" checked={on.size === hits.length} onChange={(e) => setOn(e.target.checked ? new Set(hits.map((_, i) => i)) : new Set())} /></th><th>Store in field</th><th>Now</th><th>From the source</th><th>Read from</th>{pdf && <th className="dl" title="Hover to preview the page the value was read from (source text highlighted)">🎞️</th>}{pdf && <th title="Page of the PDF the value was read from">Page</th>}</tr></thead>
                <tbody>
                  {eff.map((h, i) => {
                    const cur = show(currentOf(d, h.target));
                    const nv = show(h.value);
                    return (
                      <tr key={i} className={on.has(i) ? "sel" : undefined}>
                        <td><input type="checkbox" aria-label={h.label} checked={on.has(i)} onChange={(e) => setOn((s) => { const x = new Set(s); if (e.target.checked) x.add(i); else x.delete(i); return x; })} /></td>
                        <td>
                          <select aria-label={`Store ${hits[i].label} in`} value={targetKey(h.target)} className={remap[i] ? "remapped" : undefined} title={remap[i] ? `Found as ${hits[i].label}` : "Field the value is stored in; change it when the automatic allocation is wrong"}
                            onChange={(e) => {
                              const t = targets.find((x) => targetKey(x.target) === e.target.value)?.target;
                              if (!t) return;
                              setRemap((m) => {
                                const x = { ...m };
                                if (targetKey(t) === targetKey(hits[i].target)) delete x[i];
                                else x[i] = t;
                                return x;
                              });
                              setOn((o) => new Set(o).add(i));
                            }}>
                            {[...new Set(targets.map((x) => x.group))].map((g) => (
                              <optgroup key={g} label={g}>{targets.filter((x) => x.group === g).map((x) => <option key={targetKey(x.target)} value={targetKey(x.target)}>{x.label}</option>)}</optgroup>
                            ))}
                            {!targets.some((x) => targetKey(x.target) === targetKey(h.target)) && <option value={targetKey(h.target)}>{h.label}</option>}
                          </select>
                        </td>
                        <td className="muted">{cur}</td>
                        <td className={cur && cur !== nv ? "diff" : undefined}><b>{nv}</b></td>
                        <td className="muted clipc" title={h.from} style={{ maxWidth: 280, fontSize: 11.5 }}>{h.from}</td>
                        {pdf && (() => {
                          const s = hitSrc(hits[i]);
                          return <><td className="dl"><Film pdf={pdf} s={s} label={h.label} /></td><td className="num muted">{s ? s.pageNos.join(", ") : "—"}</td></>;
                        })()}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="bulkbox">
              <label className="chk-l"><input type="checkbox" checked={bulk} disabled={!on.size || !d.manufacturer} onChange={(e) => setBulk(e.target.checked)} /> Use this selection ({on.size} field{on.size === 1 ? "" : "s"}) for every part of the same</label>
              <select value={scope} disabled={!bulk} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Scope">
                <option value="series">manufacturer · subcategory · product series ({d.manufacturer} · {subOf(d) || "—"} · {d.series || "no series"})</option>
                <option value="sub">manufacturer · subcategory ({d.manufacturer} · {subOf(d) || "—"})</option>
                <option value="mfr">manufacturer ({d.manufacturer})</option>
              </select>
              {bulk && (
                <>
                  {mode === "ids" && <p className="errtxt" style={{ margin: 0 }}>Individual datasheet mode: every part gets the values read for {d.partNumber}. Use “Catalog / flyer table” to read each part's own row.</p>}
                  <div className="scroll" style={{ maxHeight: "30vh" }}>
                    <table className="mini wide">
                      <thead><tr><th><input type="checkbox" aria-label="All parts" checked={!skip.size} onChange={(e) => setSkip(e.target.checked ? new Set() : new Set(plan.map((x) => x.p.id)))} /></th><th>Part number</th><th>Description</th>{mode === "catalog" && <th>Row found</th>}<th>Values</th></tr></thead>
                      <tbody>
                        {plan.map(({ p, row, vals }) => (
                          <tr key={p.id} className={skip.has(p.id) || !vals.length ? "muted" : undefined}>
                            <td><input type="checkbox" aria-label={p.partNumber} disabled={!vals.length} checked={!!vals.length && !skip.has(p.id)} onChange={(e) => setSkip((x) => { const y = new Set(x); if (e.target.checked) y.delete(p.id); else y.add(p.id); return y; })} /></td>
                            <td className="mono">{p.partNumber}</td>
                            <td className="clipc" title={p.description}>{p.description}</td>
                            {mode === "catalog" && <td className="clipc mono" title={row}>{row || <span className="errtxt">not found</span>}</td>}
                            <td title={vals.map((v) => `${v.label}: ${show(v.value)}`).join("\n")}>{vals.length ? vals.map((v) => `${v.label}: ${show(v.value)}`).join(" · ").slice(0, 120) : "—"}</td>
                          </tr>
                        ))}
                        {!plan.length && <tr><td colSpan={5} className="muted">No other parts in this scope.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
      {mode === "ids" && certs.length > 0 && (
        <div className="mb certfound">
          <h4 style={{ margin: 0 }}>Certificates in this datasheet ({certs.length})</h4>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Links of the approvals / certificates grid, filed under the heading of their column. Ticked links are added to the part's certificates (Documentation tab), active; links already stored are unticked.</p>
          <table className="mini wide">
            <thead><tr><th><input type="checkbox" aria-label="All certificates" checked={certs.every((c) => c.on)} onChange={(e) => setCerts(certs.map((c) => ({ ...c, on: e.target.checked })))} /></th><th>Type</th><th>Certificate name</th><th>Title</th><th>Approval ID</th><th>Page</th><th>Link</th></tr></thead>
            <tbody>
              {certs.map((c, i) => (
                <tr key={c.url}>
                  <td><input type="checkbox" aria-label={`Add ${c.title}`} checked={c.on} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /></td>
                  <td>
                    <select aria-label={`Type of ${c.title}`} value={c.type} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                      {[...new Set([...certTypes, c.type])].map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </td>
                  <td><input type="text" aria-label="Certificate name" value={c.certName} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, certName: e.target.value } : x)))} style={{ width: 210 }} /></td>
                  <td><input type="text" aria-label="Certificate title" title={c.heading ? `Column heading in the PDF: ${c.heading}` : undefined} value={c.title} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} style={{ width: 200 }} /></td>
                  <td><input type="text" aria-label="Approval ID" className="mono" value={c.approvalId} placeholder="—" onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, approvalId: e.target.value } : x)))} style={{ width: 110 }} /></td>
                  <td className="muted num">{c.page}</td>
                  <td className="clipc"><a href={c.url} target="_blank" rel="noreferrer noopener" title={c.url}>{c.url.replace(/^https?:\/\//, "").slice(0, 60)}…</a></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="toolbar">
            <button type="button" disabled={!d.id || certBusy || !certs.some((c) => c.on)} title={d.id ? "" : "Save the part first"} onClick={async () => {
              if (!d.id) return;
              setCertBusy(true);
              const have = new Set(docs.map((x) => x.url).filter(Boolean));
              let n = 0;
              try {
                for (const c of certs.filter((x) => x.on && !have.has(x.url))) {
                  await api.parts.addLink(d.id, { kind: "Certificate", title: c.title || certTitle(c), url: c.url, ref: `${CERT_TYPE_REF}${c.type}`, certName: c.certName.trim(), approvalId: c.approvalId.trim() });
                  n++;
                }
                setDocs(await api.parts.docs(d.id));
                setCerts(certs.map((c) => ({ ...c, on: false })));
                onDocsChanged?.();
                ui.toast(`${n} certificate link${n === 1 ? "" : "s"} added to the part`);
              } catch (e) {
                ui.toast(`Stopped after ${n}: ${errMsg(e)}`);
              } finally {
                setCertBusy(false);
              }
            }}>{certBusy ? "Adding…" : `Add ${certs.filter((c) => c.on).length} certificate link${certs.filter((c) => c.on).length === 1 ? "" : "s"} to the part`}</button>
          </div>
        </div>
      )}
      <div className="mf">
        <button type="button" onClick={onClose}>Close</button>
        {bulk ? (
          <button type="button" className="btn-primary" disabled={!hits || !on.size || bulkBusy} onClick={async () => {
            const todo = plan.filter((x) => x.vals.length && !skip.has(x.p.id));
            if (!(await ui.confirm(`Apply the selected fields to this part and ${todo.length} other part${todo.length === 1 ? "" : "s"} of the master list?`, "Apply"))) return;
            setBulkBusy(true);
            const saved: Part[] = [];
            try {
              for (const { p, vals } of todo) {
                const { id, docCount: _d, updatedAt: _u, ...body } = applyHits(p, vals, emptyPowerIn);
                saved.push(await api.parts.update(id, body));
              }
              onPartsSaved?.(saved);
              ui.toast(`${saved.length} other part${saved.length === 1 ? "" : "s"} updated`);
              onApply(applyHits(d, eff.filter((_, i) => on.has(i)), emptyPowerIn));
            } catch (e) {
              ui.toast(`Stopped after ${saved.length}: ${errMsg(e)}`);
              onPartsSaved?.(saved);
            } finally {
              setBulkBusy(false);
            }
          }}>{bulkBusy ? "Applying…" : `Apply to this part + ${plan.filter((x) => x.vals.length && !skip.has(x.p.id)).length}`}</button>
        ) : (
          <button type="button" className="btn-primary" disabled={!hits || !on.size} onClick={() => onApply(applyHits(d, eff.filter((_, i) => on.has(i)), emptyPowerIn))}>Apply {on.size} value{on.size === 1 ? "" : "s"}</button>
        )}
      </div>
    </Modal>
  );
}

const isEmpty = (c: unknown) => c == null || c === "" || (Array.isArray(c) && !c.length);
/** Bulk fill (master parts list): read each part's datasheet (stored PDF, else its datasheet / product link) and fill empty fields only. */
export async function fillFromDatasheet(p: Part, fields: CustomFieldDef[]): Promise<{ part: Part; filled: number; source: string } | null> {
  const docs = await api.parts.docs(p.id);
  const rank = (x: PartDoc) => (/datasheet|data sheet/i.test(`${x.kind} ${x.title}`) ? 0 : /flyer|catalog|brochure/i.test(`${x.kind} ${x.title}`) ? 1 : /manual|guide/i.test(x.kind) ? 3 : 2);
  const cands = docs.filter((x) => (x.size > 0 && /pdf/i.test(x.mime || x.fileName)) || /^https?:/i.test(x.url)).sort((a, b) => rank(a) - rank(b));
  for (const doc of cands) {
    try {
      let pg: PageText;
      const pages = /flyer|catalog|brochure/i.test(`${doc.kind} ${doc.title}`) ? 80 : 12;
      if (doc.size > 0 && /pdf/i.test(doc.mime || doc.fileName)) pg = { title: "", text: await pdfText(new Uint8Array(await (await fetch(api.parts.docUrl(doc.id))).arrayBuffer()), pages), product: {} };
      else {
        const r = await api.parts.scrape(doc.url);
        pg = r.kind === "pdf" ? { title: "", text: await pdfText(b64(r.pdf)), product: {} } : { title: r.title, text: r.text, product: r.product };
      }
      if (/flyer|catalog|brochure/i.test(`${doc.kind} ${doc.title}`)) {
        // Catalogs / flyers: only the table row of this part number (or its SKU) counts.
        const rows = findCatalogRows(pg.text, p.partNumber);
        const r = rows.length ? rows : p.sku ? findCatalogRows(pg.text, p.sku) : [];
        if (!r.length) continue;
        pg = catalogRowText(r[0]);
      }
      const hits = extractPartData(pg, p, fields).filter((h) => !h.weak && isEmpty(currentOf(p, h.target)));
      if (!hits.length) continue;
      return { part: applyHits(p, hits, emptyPowerIn), filled: hits.length, source: doc.title || doc.fileName || doc.url };
    } catch {
      /* try the next document */
    }
  }
  return null;
}
