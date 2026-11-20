/**
 * Certificates of a part: types (editable, shared), and certificate links found in an individual datasheet PDF.
 *
 * OEM datasheets (e.g. Siemens) list approvals as a grid: a heading row with the certificate types ("Environment",
 * "General Product Approval", …), then a row of linked cells (a label such as "Confirmation" / "Miscellaneous", or a
 * logo). Each linked cell belongs to the heading above it whose left edge is at or before the cell's left edge; a grid
 * may continue on the next page under a heading row left at the bottom of the previous page.
 */
export const DEFAULT_CERT_TYPES = ["Environment", "General product approval", "Test Certificates", "Maritime application", "Other", "Railway", "Dangerous goods"];

/** Ref of a part document filed under a certificate type ("ctype:<type>"); standards keep "cert:<standard>". */
export const CERT_TYPE_REF = "ctype:";
export const certTypeOf = (ref: string | undefined): string => (ref?.startsWith(CERT_TYPE_REF) ? ref.slice(CERT_TYPE_REF.length) : "");

/** One page as pdf.js gives it: text items (x, y = baseline from the bottom, w) and link annotations (rect x1 y1 x2 y2). */
export interface PdfPageData {
  h: number;
  items: { s: string; x: number; y: number; w: number }[];
  links: { url: string; rect: number[] }[];
}
export interface CertLink {
  url: string;
  /** Text of the linked cell ("Environmental Confirmations", "Miscellaneous"…), or "" for a logo. */
  label: string;
  /** Heading of its column as printed ("General Product Approval", "EMV"…). */
  heading: string;
  /** Certificate type: the defined type matching the heading, else "Other". */
  type: string;
  page: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Links that point to certificates (approval databases, declarations of conformity…). */
export const isCertUrl = (u: string) => /certif|approval|conformit|declaration|productiq|ulprospector|\/doc\b|ce-?mark/i.test(u);

/** Certificate links of a datasheet, grouped under their column headings. `types` are the defined certificate types. */
export function certLinksFromPdf(pages: PdfPageData[], types: string[] = DEFAULT_CERT_TYPES): CertLink[] {
  const known = new Map(types.map((t) => [norm(t), t]));
  const out: CertLink[] = [];
  const seen = new Set<string>();
  let header: { x: number; text: string }[] | null = null;
  pages.forEach((pg, pi) => {
    const top = (y: number) => pg.h - y;
    // Linked cells: certificate links; rectangles with the same URL that touch vertically are one cell (two-line labels).
    const cells: { url: string; x0: number; x1: number; t: number; b: number }[] = [];
    for (const l of pg.links) {
      if (!isCertUrl(l.url)) continue;
      const [x1, y1, x2, y2] = l.rect;
      const r = { url: l.url, x0: Math.min(x1, x2), x1: Math.max(x1, x2), t: top(Math.max(y1, y2)), b: top(Math.min(y1, y2)) };
      const same = cells.find((c) => c.url === r.url && r.t - c.b < 14 && c.t - r.b < 14 && r.x0 < c.x1 + 40 && c.x0 < r.x1 + 40);
      if (same) Object.assign(same, { x0: Math.min(same.x0, r.x0), x1: Math.max(same.x1, r.x1), t: Math.min(same.t, r.t), b: Math.max(same.b, r.b) });
      else cells.push(r);
    }
    // Text rows (top-down), split into segments where the gap between items is wide.
    const rowsMap = new Map<number, { x: number; x1: number; s: string; t: number }[]>();
    for (const it of pg.items) {
      const t = top(it.y);
      const k = Math.round(t / 3);
      (rowsMap.get(k) ?? rowsMap.set(k, []).get(k)!).push({ x: it.x, x1: it.x + it.w, s: it.s.trim(), t });
    }
    const rows = [...rowsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, its]) => {
      its.sort((a, b) => a.x - b.x);
      const segs: { x: number; x1: number; text: string; t: number }[] = [];
      for (const it of its) {
        const last = segs[segs.length - 1];
        if (last && it.x - last.x1 < 12) (last.text += ` ${it.s}`), (last.x1 = it.x1);
        else segs.push({ x: it.x, x1: it.x1, text: it.s, t: it.t });
      }
      return { t: its[0].t, segs };
    });
    const inCell = (s: { x: number; x1: number; t: number }) => cells.some((c) => s.x >= c.x0 - 2 && s.x1 <= c.x1 + 2 && s.t >= c.t - 3 && s.t <= c.b + 10);
    // Walk rows and cells top-down: heading rows (no linked text, at least one segment naming a known type) set the columns.
    const events: ({ kind: "row"; t: number; segs: { x: number; text: string }[] } | { kind: "cell"; t: number; c: (typeof cells)[number] })[] = [
      ...rows.filter((r) => !r.segs.some(inCell)).map((r) => ({ kind: "row" as const, t: r.t, segs: r.segs })),
      ...cells.map((c) => ({ kind: "cell" as const, t: c.t, c })),
    ].sort((a, b) => {
      // Cells of one grid row (labels and logos start a few points apart) are read left to right.
      const ka = a.kind === "cell" ? Math.round(a.t / 10) * 10 : a.t, kb = b.kind === "cell" ? Math.round(b.t / 10) * 10 : b.t;
      return ka - kb || (a.kind === "row" ? -1 : b.kind === "row" ? 1 : a.c.x0 - (b as { c: { x0: number } }).c.x0);
    });
    for (const e of events) {
      if (e.kind === "row") {
        if (e.segs.some((s) => known.has(norm(s.text)))) header = e.segs.map((s) => ({ x: s.x, text: s.text.trim() }));
        continue;
      }
      const c = e.c;
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      const label = rows.flatMap((r) => r.segs).filter((s) => s.x >= c.x0 - 2 && s.x1 <= c.x1 + 2 && s.t >= c.t - 3 && s.t <= c.b + 10)
        .map((s) => s.text).join(" ").replace(/-\s+/g, "").replace(/\s+/g, " ").trim();
      const col = header ? [...header].reverse().find((h) => h.x <= c.x0 + 6) ?? header[0] : null;
      const heading = col?.text ?? "";
      out.push({ url: c.url, label, heading, type: known.get(norm(heading)) ?? (known.get("other") ?? "Other"), page: pi + 1 });
    }
  });
  return out;
}

/**
 * Fields of a certificate found in a datasheet: certificate name (the linked cell's text, e.g. "Environmental
 * Confirmations"; a logo: "<type> certificate (logo) n"), title (the column heading as printed, e.g. "General Product
 * Approval"), approval ID (a certificate / file number written in the cell or the link, when there is one).
 */
export function certFields(c: Pick<CertLink, "label" | "heading" | "type" | "url">, n?: number): { certName: string; title: string; approvalId: string } {
  return {
    certName: c.label || `${c.type} certificate (logo)${n ? ` ${n}` : ""}`,
    title: c.heading || `${c.type} certificate`,
    approvalId: approvalIdOf(c.url, c.label),
  };
}
/**
 * A certificate / approval number in a certificate link or its text: UL file numbers (E123456), parameters named as
 * certificate / file / approval numbers (certNo, certificateNumber, fileNumber, approvalNo, docNo…). Database category
 * ids (e.g. Siemens CertificateId / CertificateTypeId) are not certificate numbers and are left out.
 */
export function approvalIdOf(url: string, label = ""): string {
  const ul = /\b(E\d{5,6})\b/.exec(`${label} ${decodeURIComponentSafe(url)}`);
  if (ul) return ul[1];
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams) {
      if (/^(cert(ificate)?_?(no|num(ber)?)|file_?(no|num(ber)?)|approval_?(id|no|num(ber)?)|doc(ument)?_?(no|num(ber)?)|licen[cs]e_?(no|num(ber)?))$/i.test(k) && v.trim()) return v.trim().slice(0, 120);
    }
  } catch {
    /* not a URL */
  }
  return "";
}
const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Title of a stored certificate link: label (or "logo") and the heading when it is not the type itself. */
export function certTitle(c: Pick<CertLink, "label" | "heading" | "type">, n?: number): string {
  const head = c.heading && norm(c.heading) !== norm(c.type) ? `${c.heading} · ` : "";
  return `${head}${c.label || `${c.type} certificate (logo)${n ? ` ${n}` : ""}`}`;
}
