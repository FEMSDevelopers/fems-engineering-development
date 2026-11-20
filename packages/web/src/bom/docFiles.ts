import { partDocNames, type NamingStandard, type PartDoc } from "@fpl/core";
import { api } from "../api";

/** Stored files the browser can preview / open in a tab (PDF, images); other types (ZIP, DWG, STEP…) are only downloaded. */
export const canPreview = (d: Pick<PartDoc, "fileName" | "mime">) =>
  /\.(pdf|png|jpe?g|gif|webp|svg|bmp)$/i.test(d.fileName) || /^(application\/pdf|image\/)/.test(d.mime || "");

/** Generic link file (Internet Shortcut, .url) — opens the web page when double-clicked. */
export const urlFileText = (url: string) => `[InternetShortcut]\r\nURL=${url.replace(/[\r\n]/g, "")}\r\n`;

/** Download one document: its stored file, or a link as a .url file under its standard name. */
export function downloadDoc(d: PartDoc, stdName?: string) {
  const a = document.createElement("a");
  if (d.fileName) {
    a.href = api.parts.docUrl(d.id);
    a.download = d.fileName;
  } else {
    a.href = URL.createObjectURL(new Blob([urlFileText(d.url)], { type: "application/internet-shortcut" }));
    a.download = stdName || `${(d.title || "link").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").slice(0, 100)}.url`;
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Standard names of a part's documents (files and links; links get .url): the part's own documents with the part, the
 * product-series documents with the series in place of the part number (as the product-series documents name them).
 */
export function docStdNames(std: NamingStandard, docs: PartDoc[], part: { manufacturer: string; partNumber: string; series: string; mfrAlias?: string }, sub: string | undefined, seriesMode = false): Map<string, string> {
  const nameIn = (l: PartDoc[]) => l.map((x) => ({ kind: x.kind, title: x.title, fileName: x.fileName, prefix: x.prefix, suffix: x.suffix, ref: x.ref, year: x.year }));
  const own = seriesMode ? docs : docs.filter((x) => !x.seriesName);
  const m = new Map<string, string>();
  partDocNames(std, nameIn(own), part, sub).forEach((n, i) => m.set(own[i].id, n));
  const ser = seriesMode ? [] : docs.filter((x) => x.seriesName);
  if (ser.length) {
    const sn = ser[0].seriesName!;
    partDocNames(std, nameIn(ser), { ...part, partNumber: sn, series: sn }, sub).forEach((n, i) => m.set(ser[i].id, n));
  }
  return m;
}

/** Click and hold 400 ms on a column header / tab: zip download of the documents given. */
export async function downloadDocsZip(name: string, docs: PartDoc[], names: Map<string, string>, folderOf?: (d: PartDoc) => string, title?: string) {
  const entries = docs.filter((d) => d.fileName || d.url).map((d) => ({ id: d.id, path: `${folderOf ? `${folderOf(d)}/` : ""}${names.get(d.id) || d.fileName || `${d.title || "link"}.url`}` }));
  if (!entries.length) throw new Error("Nothing to download");
  await api.parts.docsZipOf(name, entries, title);
}
