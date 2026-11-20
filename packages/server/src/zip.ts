/** Minimal ZIP writer (stored, no compression) for document packages, and a ZIP reader. No dependencies beyond node:zlib. */
import { inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Build a .zip from entries (paths use "/"; names are stored as UTF-8). */
export function zip(entries: { name: string; data: Buffer | string }[], when = new Date()): Buffer {
  const { time, date } = dosTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    let name = e.name.replace(/\\/g, "/").replace(/^\/+/, "");
    // Keep names unique inside the archive.
    for (let i = 2; seen.has(name.toLowerCase()); i++) name = e.name.replace(/(\.[^./]*)?$/, (ext) => ` (${i})${ext}`);
    seen.add(name.toLowerCase());
    const nameBuf = Buffer.from(name, "utf8");
    const data = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ───────── reader ─────────

export interface ZipEntry {
  name: string;
  size: number;
  read: () => Buffer;
}
const ZIP_MAX_ENTRIES = 5000;
const ZIP_MAX_ENTRY = 200 * 1024 * 1024;

/**
 * Minimal ZIP reader (stored and deflate entries; no ZIP64, no encryption) built on node:zlib. Entries are read on
 * demand; an entry larger than 200 MB uncompressed, or more than 5000 entries, is refused.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  const bad = (m: string) => Object.assign(new Error(`Not a usable ZIP file: ${m}`), { statusCode: 400 });
  // End of central directory: last 22..(22 + 65535) bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw bad("end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw bad("ZIP64 archives are not supported");
  if (count > ZIP_MAX_ENTRIES) throw bad(`more than ${ZIP_MAX_ENTRIES} entries`);
  const out: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad("broken central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nlen).replace(/\\/g, "/");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    out.push({
      name,
      size: usize,
      read: () => {
        if (flags & 1) throw bad(`${name} is encrypted`);
        if (usize > ZIP_MAX_ENTRY) throw bad(`${name} is larger than 200 MB`);
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad(`broken entry ${name}`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) });
        throw bad(`${name} uses an unsupported compression method (${method})`);
      },
    });
  }
  return out;
}

/** Document files of a ZIP shared with a STEP model: kind and suffix by file type (AutoCAD, STEP, PDF / SVG, images). */
export interface ZipDocFile { name: string; kind: string; suffix: string; mime: string; data: Buffer }
const ZIP_DOC_TYPES: { re: RegExp; kind: string; suffix: string; mime: (ext: string) => string }[] = [
  // AutoCAD drawings, templates, standards, exchange / web formats — stored only (not previewed).
  { re: /\.(dwg|dxf|dwt|dws|dwf|dwfx|dxb)$/i, kind: "Drawing / CAD", suffix: "2D", mime: (e) => (e === "dwg" ? "image/vnd.dwg" : e === "dxf" ? "image/vnd.dxf" : e.startsWith("dwf") ? "model/vnd.dwf" : "application/acad") },
  { re: /\.(stp|step)$/i, kind: "Drawing / CAD", suffix: "STEP", mime: () => "model/step" },
  { re: /\.(pdf|svg)$/i, kind: "Drawing / CAD", suffix: "2D", mime: (e) => (e === "pdf" ? "application/pdf" : "image/svg+xml") },
  { re: /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i, kind: "Image", suffix: "", mime: (e) => (e === "jpg" ? "image/jpeg" : e === "tif" ? "image/tiff" : `image/${e}`) },
];
/** Every AutoCAD / STEP / PDF / SVG / image file of a ZIP (any folder; system files left out), with its document kind and suffix. */
export function docFilesFromZip(buf: Buffer): ZipDocFile[] {
  const out: ZipDocFile[] = [];
  for (const e of readZip(buf)) {
    if (/(^|\/)(__MACOSX\/|\.)/.test(e.name)) continue;
    const t = ZIP_DOC_TYPES.find((x) => x.re.test(e.name));
    if (!t) continue;
    const ext = e.name.split(".").pop()!.toLowerCase();
    out.push({ name: e.name.split("/").pop()!, kind: t.kind, suffix: t.suffix, mime: t.mime(ext), data: e.read() });
  }
  return out;
}

/**
 * A STEP model from a ZIP (STEP files are often shared with a .txt next to them): the .stp/.step entry (the one with a
 * matching .txt when there are several, else the largest) and its .txt (same base name, else the only / first .txt).
 */
export function stepFromZip(buf: Buffer): { stepName: string; step: Buffer; txtName: string | null; txt: string | null; others: number } {
  const all = readZip(buf).filter((e) => !/(^|\/)(__MACOSX\/|\.)/.test(e.name));
  const base = (n: string) => n.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
  const steps = all.filter((e) => /\.(stp|step)$/i.test(e.name));
  const txts = all.filter((e) => /\.txt$/i.test(e.name));
  if (!steps.length) throw Object.assign(new Error("No .stp / .step file found in the ZIP"), { statusCode: 400 });
  const step = steps.find((s) => txts.some((t) => base(t.name) === base(s.name))) ?? [...steps].sort((a, b) => b.size - a.size)[0];
  const txt = txts.find((t) => base(t.name) === base(step.name)) ?? txts[0] ?? null;
  const tb = txt && txt.size <= 1024 * 1024 ? txt.read() : null;
  return {
    stepName: step.name.split("/").pop()!,
    step: step.read(),
    txtName: txt ? txt.name.split("/").pop()! : null,
    txt: tb ? tb.toString("utf8").replace(/^﻿/, "").replace(/\0/g, "") : null,
    others: steps.length - 1,
  };
}
