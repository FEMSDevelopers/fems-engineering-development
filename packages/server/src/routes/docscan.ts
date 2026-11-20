import { DEFAULT_DOC_PREFIXES, DOC_MIME, buildCodeIndex, matchDocFile, normExts, type DocPrefix, type DocWord } from "@fpl/core";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import type { Db } from "../db.js";

const MAX_FILE = 100 * 1024 * 1024;
const MAX_FILES = 200_000;
const MAX_DEPTH = 40;

/** Absolute, normalised folder path; case-insensitive comparison on Windows. */
const norm = (p: string) => path.resolve(p.trim().replace(/^"(.*)"$/, "$1"));
const key = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(key(norm(dir)), key(norm(file)));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
function allowedDir(dir: string): string | null {
  if (!path.isAbsolute(dir.trim().replace(/^"(.*)"$/, "$1"))) return "Use an absolute folder path (e.g. C:\\Datasheets or \\\\server\\share\\Datasheets)";
  if (config.docScanRoots.length && !config.docScanRoots.some((r) => isInside(dir, r))) return `Outside the folders allowed on this server (DOC_SCAN_ROOTS: ${config.docScanRoots.join("; ")})`;
  return null;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// A row needs a prefix and/or a wildcard "contains" text.
const PrefixZ = z.object({ prefix: z.string().trim().max(20).default(""), contains: z.string().trim().max(200).optional(), kind: z.string().trim().min(1).max(60) })
  .refine((r) => !!r.prefix || !!r.contains, "Each row needs a prefix or a contains text");
const ScanZ = z.object({
  dirs: z.array(z.string().min(1).max(1000)).min(1).max(50),
  exts: z.array(z.string().max(10)).max(30).default(["pdf"]),
  prefixes: z.array(PrefixZ).max(100).default(DEFAULT_DOC_PREFIXES),
  /** Words recognised in the name when the prefix is unknown (empty = off: unknown prefixes go to Other). */
  words: z.array(z.object({ word: z.string().trim().min(3).max(40), kind: z.string().trim().min(1).max(60) })).max(100).default([]),
  partIds: z.array(z.string().uuid()).max(50_000).optional(),
  mode: z.enum(["add", "overwrite"]).default("add"),
  useSku: z.boolean().default(false),
});

interface Found {
  path: string;
  dir: string;
  rel: string;
  name: string;
  size: number;
  mtime: string;
}

/** Every file with one of the extensions under the folders (all sub-folders; links to folders are not followed). */
async function walk(dirs: string[], exts: Set<string>) {
  const out: Found[] = [];
  const report: { dir: string; ok: boolean; files: number; error?: string }[] = [];
  let scanned = 0;
  let truncated = false;
  for (const d0 of dirs) {
    const dir = norm(d0);
    const bad = allowedDir(d0);
    if (bad) {
      report.push({ dir: d0, ok: false, files: 0, error: bad });
      continue;
    }
    let n = 0;
    const errors: string[] = [];
    const visit = async (d: string, depth: number) => {
      if (truncated || depth > MAX_DEPTH) return;
      let ents: import("node:fs").Dirent[];
      try {
        ents = await fs.readdir(d, { withFileTypes: true });
      } catch (e) {
        if (d === dir) throw e;
        errors.push(`${path.relative(dir, d)}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
        return;
      }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await visit(p, depth + 1);
        else if (e.isFile()) {
          if (++scanned > MAX_FILES) {
            truncated = true;
            return;
          }
          const ext = path.extname(e.name).slice(1).toLowerCase();
          if (!exts.has(ext)) continue;
          try {
            const st = await fs.stat(p);
            out.push({ path: p, dir, rel: path.relative(dir, p), name: e.name, size: st.size, mtime: st.mtime.toISOString() });
            n++;
          } catch {
            /* vanished */
          }
        }
      }
    };
    try {
      await visit(dir, 0);
      report.push({ dir: d0, ok: true, files: n, ...(errors.length ? { error: `${errors.length} sub-folder(s) could not be read: ${errors.slice(0, 3).join("; ")}` } : {}) });
    } catch (e) {
      report.push({ dir: d0, ok: false, files: 0, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "Folder not found" : (e as Error).message });
    }
  }
  return { files: out, report, scanned, truncated };
}

/**
 * Parts → 🗃️ Scan folders for documents.
 *   GET  /api/parts/doc-scan          { enabled, roots }
 *   POST /api/parts/doc-scan          dry run: files whose name holds a part number, their kind and what would happen
 *   POST /api/parts/doc-scan/apply    store the chosen files as part documents (add, or replace a document of the same file name)
 */
export function docScanRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/parts/doc-scan", async () => ({ enabled: config.docScan, roots: config.docScanRoots, platform: process.platform }));

  app.post("/api/parts/doc-scan", async (req, reply) => {
    if (!config.docScan) return reply.code(403).send({ error: "Folder scanning is turned off on this server (DOC_SCAN=off)." });
    const b = ScanZ.parse(req.body);
    const exts = new Set(normExts(b.exts));
    if (!exts.size) return reply.code(400).send({ error: "No file types" });
    const parts = (await db.query(
      `SELECT id, manufacturer, part_number, sku FROM parts ${b.partIds ? "WHERE id = ANY($1::uuid[])" : ""}`, b.partIds ? [b.partIds] : [],
    )).rows as { id: string; manufacturer: string; part_number: string; sku: string }[];
    const index = buildCodeIndex(parts.map((p) => ({ id: p.id, partNumber: p.part_number, sku: p.sku })), b.useSku);
    const { files, report, scanned, truncated } = await walk(b.dirs, exts);
    // Existing documents of the parts: by file name (case-insensitive) and by content hash.
    const ids = parts.map((p) => p.id);
    const docs = ids.length
      ? (await db.query(`SELECT id, part_id, kind, file_name, encode(sha256(data), 'hex') AS hash FROM part_docs WHERE part_id = ANY($1::uuid[]) AND data IS NOT NULL`, [ids])).rows as
        { id: string; part_id: string; kind: string; file_name: string; hash: string }[]
      : [];
    const byName = new Map<string, (typeof docs)[number]>();
    const hashes = new Map<string, Set<string>>();
    for (const d of docs) {
      byName.set(`${d.part_id}|${d.file_name.toLowerCase()}`, d);
      if (!hashes.has(d.part_id)) hashes.set(d.part_id, new Set());
      hashes.get(d.part_id)!.add(d.hash);
    }
    const pmap = new Map(parts.map((p) => [p.id, p]));
    const items: Record<string, unknown>[] = [];
    let unmatched = 0;
    const unmatchedFiles: string[] = [];
    const hashOf = new Map<string, string>();
    const fileHash = async (p: string, size: number) => {
      if (size > MAX_FILE) return "";
      if (!hashOf.has(p)) hashOf.set(p, sha(await fs.readFile(p)));
      return hashOf.get(p)!;
    };
    // Newest copy first: the same document is often filed under several projects.
    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    const seen = new Map<string, Set<string>>();
    for (const f of files) {
      const m = matchDocFile(f.name, index, b.prefixes as DocPrefix[], b.words as DocWord[]);
      if (!m) {
        unmatched++;
        if (unmatchedFiles.length < 1000) unmatchedFiles.push(path.join(path.basename(f.dir), f.rel));
        continue;
      }
      for (const pid of m.partIds) {
        const p = pmap.get(pid)!;
        const same = byName.get(`${pid}|${f.name.toLowerCase()}`);
        let action: "add" | "replace" | "exists" | "identical" | "dup" | "too-big" = "add";
        let h = "";
        if (f.size > MAX_FILE) action = "too-big";
        else {
          try {
            h = await fileHash(f.path, f.size);
          } catch {
            h = "";
          }
          const s = seen.get(pid) ?? new Set<string>();
          seen.set(pid, s);
          if (h && hashes.get(pid)?.has(h)) action = "identical";
          else if (s.has(`n:${f.name.toLowerCase()}`) || (h && s.has(`h:${h}`))) action = "dup";
          else if (same) action = b.mode === "overwrite" ? "replace" : "exists";
          s.add(`n:${f.name.toLowerCase()}`);
          if (h) s.add(`h:${h}`);
        }
        items.push({
          path: f.path, dir: f.dir, rel: f.rel, name: f.name, size: f.size, mtime: f.mtime,
          partId: pid, manufacturer: p.manufacturer, partNumber: p.part_number, codes: m.codes, prefix: m.prefix, kind: m.kind, by: m.by ?? "",
          action, docId: same?.id ?? null, docKind: same?.kind ?? null,
        });
      }
    }
    return { scanned, matched: items.length, unmatched, unmatchedFiles, truncated, dirs: report, items };
  });

  app.post("/api/parts/doc-scan/apply", async (req, reply) => {
    if (!config.docScan) return reply.code(403).send({ error: "Folder scanning is turned off on this server (DOC_SCAN=off)." });
    const b = z.object({
      dirs: z.array(z.string().min(1).max(1000)).min(1).max(50),
      exts: z.array(z.string().max(10)).max(30),
      items: z.array(z.object({
        path: z.string().min(1).max(4000), partId: z.string().uuid(), kind: z.string().trim().min(1).max(60), title: z.string().max(300).optional(),
        replaceDocId: z.string().uuid().nullable().optional(),
      })).min(1).max(200),
    }).parse(req.body);
    const exts = new Set(normExts(b.exts));
    const dirs = b.dirs.filter((d) => !allowedDir(d));
    let added = 0;
    let replaced = 0;
    const errors: { path: string; error: string }[] = [];
    for (const it of b.items) {
      try {
        const file = norm(it.path);
        // Only files under the scanned folders, with a scanned extension, are read.
        if (!dirs.some((d) => isInside(file, d))) throw new Error("Not inside the scanned folders");
        const ext = path.extname(file).slice(1).toLowerCase();
        if (!exts.has(ext)) throw new Error("File type not scanned");
        const st = await fs.stat(file);
        if (!st.isFile()) throw new Error("Not a file");
        if (st.size > MAX_FILE) throw new Error("Larger than 100 MB");
        const data = await fs.readFile(file);
        const name = path.basename(file);
        const mime = DOC_MIME[ext] ?? "application/octet-stream";
        const title = (it.title ?? "").trim() || name.replace(/\.[^.]+$/, "");
        if (it.replaceDocId) {
          const r = await db.query(
            "UPDATE part_docs SET data = $3, size = $4, mime = $5, file_name = $6, kind = $7, url = '' WHERE id = $1 AND part_id = $2",
            [it.replaceDocId, it.partId, data, data.length, mime, name, it.kind],
          );
          if (!r.rowCount) throw new Error("Document to replace not found");
          replaced++;
        } else {
          await db.query("INSERT INTO part_docs(part_id, kind, title, file_name, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6,$7)", [it.partId, it.kind, title, name, mime, data.length, data]);
          added++;
        }
        await db.query("UPDATE parts SET updated_at = now() WHERE id = $1", [it.partId]);
      } catch (e) {
        errors.push({ path: it.path, error: (e as Error).message });
      }
    }
    return reply.send({ added, replaced, errors });
  });
}
