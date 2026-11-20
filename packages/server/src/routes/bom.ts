import { effectiveDesc, effectivePn, DEFAULT_NAMING, EMPTY_MECH, aliasOf, DOC_MIME, compareKeys, evalNode, execCode, parseExpr, partDocNames, partKey, toCSV, type PyScope, type PyValue, type NamingStandard, type Grid, type Part, type PartDoc, type Subcategory } from "@fpl/core";
import ExcelJS from "exceljs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { zip } from "../zip.js";

type Row = Record<string, unknown>;
const IdP = z.object({ id: z.string().uuid() });
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

// ───────── mapping ─────────

export const subcatFromRow = (r: Row): Subcategory => ({
  id: String(r.id), category: String(r.category ?? ""), name: String(r.name ?? ""), tagPrefix: String(r.tag_prefix ?? ""),
  fields: (r.fields as Subcategory["fields"]) ?? [], portTypes: (r.port_types as string[]) ?? [], sort: Number(r.sort ?? 0),
});
export const partFromRow = (r: Row): Part => ({
  id: String(r.id), category: String(r.category ?? ""), subcategoryId: (r.subcategory_id as string) ?? null,
  manufacturer: String(r.manufacturer ?? ""), series: String(r.series ?? ""), partNumber: String(r.part_number ?? ""), description: String(r.description ?? ""),
  vendor: String(r.vendor ?? ""), vendorContact: String(r.vendor_contact ?? ""), sku: String(r.sku ?? ""),
  effPnExpr: String(r.eff_pn_expr ?? ""), effPn: String(r.eff_pn || r.part_number || ""),
  effDescExpr: String(r.eff_desc_expr ?? ""), effDesc: String(r.eff_desc || r.description || ""), effPrice: num(r.eff_price), effApply: r.eff_apply === true,
  effVersions: (r.eff_versions as Part["effVersions"]) ?? [], effVersionId: (r.eff_version_id as string) ?? null,
  configCode1: String(r.config_code1 ?? ""), configCode2: String(r.config_code2 ?? ""), configCode3: String(r.config_code3 ?? ""), notes: String(r.notes ?? ""), oemDesc: String(r.oem_desc ?? ""), tagPrefix: String(r.tag_prefix ?? ""),
  status: (String(r.status ?? "active") as Part["status"]) || "active", stock: num(r.stock), onOrder: num(r.on_order), price: num(r.price),
  mech: { ...EMPTY_MECH, ...((r.mech as object) ?? {}) }, powerIn: (r.power_in as Part["powerIn"]) ?? null, powerOut: (r.power_out as Part["powerOut"]) ?? null,
  ports: (r.ports as Part["ports"]) ?? [], custom: (r.custom as Part["custom"]) ?? {}, docCount: Number(r.doc_count ?? 0), views: (r.views as string[]) ?? [],
  updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : undefined,
});
/** Generic link file (Internet Shortcut, .url): opens the web page when double-clicked (documentation packages). */
export const urlFile = (url: string) => `[InternetShortcut]\r\nURL=${url.replace(/[\r\n]/g, "")}\r\n`;
/** A document of a package: the stored file, or a link as a .url file, under its standard name in the folder. */
function docEntry(d: Row, folder: string, name: string, entries: { name: string; data: Buffer | string }[]) {
  const path = d.data || d.url ? `${folder}/${safeName(name)}` : "";
  if (d.data) entries.push({ name: path, data: d.data as Buffer });
  else if (d.url) entries.push({ name: path, data: urlFile(String(d.url)) });
  return { kind: String(d.kind ?? ""), title: String(d.title ?? ""), folder: path ? folder : "", path, url: String(d.url ?? ""), ref: String(d.ref ?? "").replace(/^cert:/, "") };
}
const docFromRow = (r: Row): PartDoc => ({
  ...(r.part_id ? {} : { seriesMfr: String(r.series_mfr ?? ""), seriesName: String(r.series_name ?? "") }),
  id: String(r.id), partId: String(r.part_id ?? ""), kind: String(r.kind ?? ""), ref: String(r.ref ?? ""), prefix: String(r.prefix ?? ""), suffix: String(r.suffix ?? ""), title: String(r.title ?? ""), url: String(r.url ?? ""),
  fileName: String(r.file_name ?? ""), mime: String(r.mime ?? ""), size: Number(r.size ?? 0), createdAt: new Date(r.created_at as string).toISOString(),
  active: r.active !== false, year: r.year == null ? null : Number(r.year),
  approvalId: String(r.approval_id ?? ""),
  certName: String(r.cert_name ?? ""),
});

// ───────── validation ─────────

const n = z.number().finite().nullable();
const terminals = z.array(z.string().max(40)).max(40);
const PowerInZ = z.object({
  kind: z.enum(["", "AC1", "AC3", "DC"]), voltage: n, range: z.string().max(100), watts: n, amps: n, pf: n, feeds: z.number().int().min(0).max(16), terminals,
}).nullable();
const PowerOutZ = z.object({ kind: z.enum(["", "AC1", "AC3", "DC"]), voltage: n, watts: n, amps: n, efficiency: n, terminals }).nullable();
const MechZ = z.object({
  mount: z.enum(["", "rack", "din", "panel", "wall", "floor", "shelf", "none"]), rackUnits: n, widthMm: n, heightMm: n, depthMm: n, dinWidthMm: n, weightKg: n,
  addXMm: n, addYMm: n, addZMm: n, useViews: z.boolean(), fullDepth: z.boolean(),
}).partial();
const PortZ = z.object({ id: z.string().max(64), type: z.string().max(60), count: z.number().int().min(0).max(1024), speed: z.string().max(60), label: z.string().max(100), notes: z.string().max(500) });
const t = (max = 2000) => z.string().max(max);
const PartZ = z.object({
  category: t(100), subcategoryId: z.string().uuid().nullable(), manufacturer: t(200), series: t(200), partNumber: t(200), description: t(4000),
  vendor: t(500), vendorContact: t(2000), sku: t(200), effPnExpr: t(4000), effDescExpr: t(4000), effPrice: n, effApply: z.boolean(),
  effVersions: z.array(z.object({
    id: z.string().max(64), major: z.number().int().min(0), minor: z.number().int().min(0), pnExpr: t(4000), descExpr: t(4000), price: n, notes: t(2000), savedAt: t(40),
    cfgId: t(64).optional(), cfgName: t(200).optional(),
    sku: t(200).optional(), configCode1: t(300).optional(), configCode2: t(300).optional(), configCode3: t(300).optional(),
  })).max(500),
  effVersionId: z.string().max(64).nullable(), configCode1: t(300), configCode2: t(300), configCode3: t(300), notes: t(4000), oemDesc: t(8000), tagPrefix: t(40), status: z.enum(["active", "spares", "obsolete"]),
  stock: n, onOrder: n, price: n, mech: MechZ, powerIn: PowerInZ, powerOut: PowerOutZ, ports: z.array(PortZ).max(200),
  custom: z.record(z.string().max(60), z.union([
    z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(100), z.tuple([z.number().nullable(), z.number().nullable()]),
  ])),
}).partial();
const COLS: Record<string, [string, "text" | "json" | "raw"]> = {
  category: ["category", "text"], subcategoryId: ["subcategory_id", "raw"], manufacturer: ["manufacturer", "text"], series: ["series", "text"],
  partNumber: ["part_number", "text"], description: ["description", "text"], vendor: ["vendor", "text"], vendorContact: ["vendor_contact", "text"],
  sku: ["sku", "text"], effPnExpr: ["eff_pn_expr", "text"], effDescExpr: ["eff_desc_expr", "text"], effPrice: ["eff_price", "raw"], effApply: ["eff_apply", "raw"],
  effVersions: ["eff_versions", "json"], effVersionId: ["eff_version_id", "raw"], configCode1: ["config_code1", "text"], configCode2: ["config_code2", "text"], configCode3: ["config_code3", "text"],
  notes: ["notes", "text"], oemDesc: ["oem_desc", "text"], tagPrefix: ["tag_prefix", "text"], status: ["status", "text"], stock: ["stock", "raw"], onOrder: ["on_order", "raw"],
  price: ["price", "raw"], mech: ["mech", "json"], powerIn: ["power_in", "json"], powerOut: ["power_out", "json"], ports: ["ports", "json"], custom: ["custom", "json"],
};
const FieldDefZ = z.object({
  key: z.string().min(1).max(60), label: z.string().max(100), type: z.enum(["text", "number", "bool", "select", "multi", "range", "certs"]),
  unit: z.string().max(20).optional(), options: z.array(z.string().max(100)).max(200).optional(), group: z.string().max(60).optional(), help: z.string().max(500).optional(),
});
const SubcatZ = z.object({ category: t(100), name: t(200), tagPrefix: t(40), fields: z.array(FieldDefZ).max(100), portTypes: z.array(z.string().max(60)).max(100), sort: z.number().int() }).partial();

function colVal(k: string, v: unknown) {
  const [, kind] = COLS[k];
  if (kind === "json") return v == null ? null : JSON.stringify(v);
  if (kind === "text") return v ?? "";
  return v ?? null;
}
const PART_SEL = `SELECT p.*, (SELECT count(*) FROM part_docs d WHERE d.part_id = p.id OR d.series_key = fpl_series_key(p.manufacturer, p.series)) AS doc_count,
  (SELECT array_agg(v.view ORDER BY v.view) FROM part_views v WHERE v.part_id = p.id) AS views FROM parts p`;

export async function loadParts(db: Db, ids?: string[]): Promise<Part[]> {
  const r = ids ? await db.query(`${PART_SEL} WHERE p.id = ANY($1::uuid[])`, [ids]) : await db.query(`${PART_SEL} ORDER BY p.category, p.manufacturer, p.part_number`);
  return r.rows.map(partFromRow);
}

async function insertPart(db: Db | import("pg").PoolClient, body: Record<string, unknown>): Promise<string> {
  const keys = Object.keys(COLS).filter((k) => body[k] !== undefined);
  if (!keys.length) return (await db.query("INSERT INTO parts DEFAULT VALUES RETURNING id")).rows[0].id;
  const r = await db.query(
    `INSERT INTO parts(${keys.map((k) => COLS[k][0]).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    keys.map((k) => colVal(k, body[k])),
  );
  await syncEffPn(db, r.rows[0].id);
  return r.rows[0].id;
}
/** Re-compute the effective part number of a part (Python over its fields) after it was written. */
async function syncEffPn(db: Db | import("pg").PoolClient, id: string) {
  const r = (await db.query("SELECT p.*, s.name AS sub_name FROM parts p LEFT JOIN part_subcats s ON s.id = p.subcategory_id WHERE p.id = $1", [id])).rows[0];
  if (!r) return;
  // Manufacturer aliases (mfr_alias): ui_presets scope "bom.mfr-alias", name "aliases" (Parts → Manufacturer aliases…).
  const al = (await db.query("SELECT data FROM ui_presets WHERE scope = 'bom.mfr-alias' AND name = 'aliases'")).rows[0]?.data as Record<string, string> | undefined;
  const p = partFromRow(r);
  const v = effectivePn(p, String(r.sub_name ?? ""), { aliases: al ?? {} }).text;
  const dsc = effectiveDesc(p, String(r.sub_name ?? ""), { aliases: al ?? {} }).text;
  if (v !== r.eff_pn || dsc !== r.eff_desc) await db.query("UPDATE parts SET eff_pn = $2, eff_desc = $3 WHERE id = $1", [id, v, dsc]);
}
async function updatePart(db: Db | import("pg").PoolClient, id: string, body: Record<string, unknown>) {
  const keys = Object.keys(COLS).filter((k) => body[k] !== undefined);
  if (!keys.length) return 0;
  const r = await db.query(`UPDATE parts SET ${keys.map((k, i) => `${COLS[k][0]} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => colVal(k, body[k]))]);
  if (r.rowCount) await syncEffPn(db, id);
  return r.rowCount ?? 0;
}

// ───────── files ─────────

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function file(reply: FastifyReply, name: string, type: string, body: string | Buffer) {
  const safe = name.replace(/[^\w.\- ()]+/g, "_");
  return reply.header("content-type", type).header("content-disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`).send(body);
}
const SheetZ = z.object({
  name: z.string().min(1).max(31),
  title: z.string().max(300).optional(),
  grid: z.array(z.array(z.string().max(20000))).max(100000),
  /** Row indices (in grid) drawn as group / section rows. */
  groupRows: z.array(z.number().int()).max(100000).optional(),
});

/** Workbook in the drawing-set table style: optional title row, bold header, group rows shaded, auto widths. */
export async function styledXlsx(sheets: z.infer<typeof SheetZ>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const s of sheets) {
    let name = s.name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet";
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${s.name.slice(0, 27)} (${i})`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    let off = 0;
    if (s.title) {
      ws.addRow([s.title]).font = { bold: true, size: 12 };
      if (s.grid[0]?.length > 1) ws.mergeCells(1, 1, 1, s.grid[0].length);
      off = 1;
    }
    // Numbers are written as numbers, except in identifier columns (part numbers, item numbers, tags) which stay text.
    const textCol = (s.grid[0] ?? []).map((h) => /PART|NUMBER|^NO\.?$|ITEM|TAG|PREFIX|MANUFACTURER|DESCRIPTION|UNIT$|FILE|LINK/i.test(h));
    s.grid.forEach((r, ri) => ws.addRow(r.map((v, ci) => (ri > 0 && !textCol[ci] && /^-?\d+(\.\d+)?$/.test(v) && v.length < 15 && !/^0\d/.test(v) ? Number(v) : v))));
    const head = ws.getRow(off + 1);
    head.font = { bold: true };
    head.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2E7" } };
      c.border = { bottom: { style: "thin" } };
    });
    for (const gi of s.groupRows ?? []) {
      const row = ws.getRow(off + gi + 1);
      row.font = { bold: true };
      row.eachCell({ includeEmpty: true }, (c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F4F6" } }));
    }
    ws.views = [{ state: "frozen", ySplit: off + 1 }];
    ws.columns.forEach((c) => {
      let w = 6;
      c.eachCell?.({ includeEmpty: false }, (cell, rn) => rn > off && (w = Math.max(w, Math.min(70, String(cell.value ?? "").length + 2))));
      c.width = w;
      c.alignment = { wrapText: w >= 70, vertical: "top" };
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "_";

// ───────── routes ─────────

export function bomRoutes(app: FastifyInstance, db: Db) {
  // Template library directory (assembly templates carry a folder path "A/B"; empty folders are kept here).
  const FolderP = z.object({ path: z.string().trim().min(1).max(400) });
  const normPath = (p: string) => p.split("/").map((x) => x.trim()).filter(Boolean).join("/");
  app.get("/api/asm-folders", async () => {
    const a = (await db.query("SELECT path FROM asm_folders")).rows.map((r) => String(r.path));
    const b = (await db.query("SELECT DISTINCT folder FROM bom_assemblies WHERE folder <> ''")).rows.map((r) => String(r.folder));
    const all = new Set<string>();
    for (const p of [...a, ...b]) {
      const parts = normPath(p).split("/");
      for (let i = 1; i <= parts.length; i++) if (parts[i - 1]) all.add(parts.slice(0, i).join("/"));
    }
    return [...all].sort((x, y) => x.localeCompare(y));
  });
  app.post("/api/asm-folders", async (req, reply) => {
    const path = normPath(FolderP.parse(req.body ?? {}).path);
    if (!path) return reply.code(400).send({ error: "Empty folder name" });
    await db.query("INSERT INTO asm_folders(path) VALUES ($1) ON CONFLICT DO NOTHING", [path]);
    return reply.code(201).send({ path });
  });
  // Rename / move a folder (and everything below it).
  app.patch("/api/asm-folders", async (req) => {
    const b = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(req.body ?? {});
    const from = normPath(b.from);
    const to = normPath(b.to);
    const rows = (await db.query("SELECT path FROM asm_folders WHERE path = $1 OR path LIKE $2", [from, `${from}/%`])).rows.map((r) => String(r.path));
    await db.query("DELETE FROM asm_folders WHERE path = $1 OR path LIKE $2", [from, `${from}/%`]);
    for (const p of [from, ...rows]) await db.query("INSERT INTO asm_folders(path) VALUES ($1) ON CONFLICT DO NOTHING", [to + p.slice(from.length)]);
    await db.query("UPDATE bom_assemblies SET folder = $2 || substr(folder, length($1) + 1) WHERE folder = $1 OR folder LIKE $3", [from, to, `${from}/%`]);
    return { path: to };
  });
  // Delete a folder: its templates (and sub-folders) move to the parent folder.
  app.delete("/api/asm-folders", async (req) => {
    const path = normPath(FolderP.parse(req.body ?? {}).path);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    await db.query("DELETE FROM asm_folders WHERE path = $1 OR path LIKE $2", [path, `${path}/%`]);
    await db.query("UPDATE bom_assemblies SET folder = $2 WHERE folder = $1 OR folder LIKE $3", [path, parent, `${path}/%`]);
    return { ok: true };
  });
  // Subcategories
  app.get("/api/part-subcats", async () => (await db.query("SELECT * FROM part_subcats ORDER BY sort, created_at")).rows.map(subcatFromRow));
  app.post("/api/part-subcats", async (req, reply) => {
    const b = SubcatZ.parse(req.body ?? {});
    const sort = b.sort ?? Number((await db.query("SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM part_subcats")).rows[0].n);
    const r = await db.query(
      "INSERT INTO part_subcats(category, name, tag_prefix, fields, port_types, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [b.category ?? "", b.name ?? "", b.tagPrefix ?? "", JSON.stringify(b.fields ?? []), JSON.stringify(b.portTypes ?? []), sort],
    );
    return reply.code(201).send(subcatFromRow(r.rows[0]));
  });
  app.patch("/api/part-subcats/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const b = SubcatZ.parse(req.body ?? {});
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      category: ["category", (v) => v], name: ["name", (v) => v], tagPrefix: ["tag_prefix", (v) => v], fields: ["fields", (v) => JSON.stringify(v)],
      portTypes: ["port_types", (v) => JSON.stringify(v)], sort: ["sort", (v) => v],
    };
    const keys = Object.keys(map).filter((k) => (b as Row)[k] !== undefined);
    if (!keys.length) return reply.code(400).send({ error: "Nothing to update" });
    const r = await db.query(`UPDATE part_subcats SET ${keys.map((k, i) => `${map[k][0]} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => map[k][1]((b as Row)[k]))]);
    return r.rowCount ? subcatFromRow(r.rows[0]) : reply.code(404).send({ error: "Not found" });
  });
  app.post("/api/part-subcats/reorder", async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(5000) }).parse(req.body);
    for (let i = 0; i < ids.length; i++) await db.query("UPDATE part_subcats SET sort = $2 WHERE id = $1", [ids[i], i]);
    return { ok: true };
  });
  app.delete("/api/part-subcats/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    await db.query("DELETE FROM part_subcats WHERE id = $1", [id]);
    return reply.code(204).send();
  });

  // Parts
  app.get("/api/parts", async () => loadParts(db));
  app.post("/api/parts", async (req, reply) => {
    const body = PartZ.parse(req.body ?? {}) as Row;
    const id = await insertPart(db, body);
    return reply.code(201).send((await loadParts(db, [id]))[0]);
  });
  app.patch("/api/parts/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const body = PartZ.parse(req.body ?? {}) as Row;
    if (!(await updatePart(db, id, body))) return reply.code(404).send({ error: "Not found" });
    return (await loadParts(db, [id]))[0];
  });
  // Bulk update: several parts, each with its own partial update, in one transaction.
  app.post("/api/parts/bulk-update", async (req) => {
    const { items } = z.object({ items: z.array(z.object({ id: z.string().uuid(), patch: PartZ })).max(20000) }).parse(req.body);
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      let n = 0;
      for (const it of items) n += await updatePart(c, it.id, it.patch as Row);
      await c.query("COMMIT");
      return { updated: n, parts: items.length ? await loadParts(db, items.map((i) => i.id)) : [] };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  });
  app.delete("/api/parts/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    await db.query("DELETE FROM parts WHERE id = $1", [id]);
    return reply.code(204).send();
  });
  app.post("/api/parts/delete", async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(20000) }).parse(req.body);
    const r = await db.query("DELETE FROM parts WHERE id = ANY($1::uuid[])", [ids]);
    return { deleted: r.rowCount ?? 0 };
  });
  /**
   * Bulk import. Rows match existing parts by manufacturer + part number:
   * mode "skip" leaves matches alone, "update" overwrites the given non-empty fields.
   */
  app.post("/api/parts/import", async (req) => {
    const { rows, mode } = z.object({ rows: z.array(PartZ).max(20000), mode: z.enum(["skip", "update"]).default("skip") }).parse(req.body);
    const c = await db.connect();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    try {
      await c.query("BEGIN");
      const existing = new Map<string, string>();
      for (const r of (await c.query("SELECT id, manufacturer, part_number FROM parts")).rows) existing.set(partKey(r.manufacturer, r.part_number), r.id);
      for (const raw of rows as Row[]) {
        if (!String(raw.partNumber ?? "").trim()) {
          skipped++;
          continue;
        }
        const k = partKey(String(raw.manufacturer ?? ""), String(raw.partNumber ?? ""));
        const hit = existing.get(k);
        if (hit) {
          if (mode === "update") {
            const body = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== "" && v !== null && v !== undefined));
            await updatePart(c, hit, body);
            updated++;
          } else skipped++;
        } else {
          existing.set(k, await insertPart(c, raw));
          created++;
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    return { created, updated, skipped };
  });

  // Documents (uploaded file or link)
  /** Document kinds per part (no file data): `?ids=a,b` or every part. Used by the BOM builder's DocType column. */
  app.get("/api/part-docs/kinds", async (req) => {
    const raw = String((req.query as Row)?.ids ?? "").trim();
    const ids = raw ? raw.split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 5000) : null;
    if (ids && !ids.length) return [];
    const r = ids
      ? await db.query(`SELECT d.id, p.id AS part_id, d.kind, d.active, d.title, d.file_name, d.mime, d.url FROM parts p
          JOIN part_docs d ON d.part_id = p.id OR d.series_key = fpl_series_key(p.manufacturer, p.series) WHERE p.id = ANY($1::uuid[]) ORDER BY p.id, d.kind, d.created_at`, [ids])
      : await db.query(`SELECT d.id, p.id AS part_id, d.kind, d.active, d.title, d.file_name, d.mime, d.url FROM parts p
          JOIN part_docs d ON d.part_id = p.id OR d.series_key = fpl_series_key(p.manufacturer, p.series) ORDER BY p.id, d.kind, d.created_at`);
    // (document id, title, file name and type: the DocType column previews the document of each code)
    return r.rows.map((x) => ({ id: x.id as string, partId: x.part_id as string, kind: x.kind as string, active: x.active !== false, title: String(x.title ?? ""), fileName: String(x.file_name ?? ""), mime: String(x.mime ?? ""), url: String(x.url ?? "") }));
  });
  app.get("/api/parts/:id/docs", async (req) => {
    const { id } = IdP.parse(req.params);
    // The part's own documents, then the documents of its manufacturer + product series (shared by the series).
    return (await db.query(`SELECT d.id, d.part_id, d.kind, d.ref, d.prefix, d.suffix, d.title, d.url, d.file_name, d.mime, d.size, d.created_at, d.active, d.year, d.series_mfr, d.series_name, d.approval_id, d.cert_name FROM parts p JOIN part_docs d ON d.part_id = p.id OR d.series_key = fpl_series_key(p.manufacturer, p.series)
      WHERE p.id = $1 ORDER BY (d.part_id IS NULL), d.kind, d.created_at`, [id])).rows.map(docFromRow);
  });
  app.post("/api/parts/:id/docs", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    if (!(await db.query("SELECT 1 FROM parts WHERE id = $1", [id])).rowCount) return reply.code(404).send({ error: "Part not found" });
    if (req.isMultipart()) {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: "No file" });
      const data = await f.toBuffer();
      const field = (k: string) => {
        const v = f.fields[k] as { value?: unknown } | undefined;
        return v && typeof v.value === "string" ? v.value : "";
      };
      const r = await db.query(
        "INSERT INTO part_docs(part_id, kind, ref, title, file_name, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, part_id, kind, ref, prefix, suffix, title, url, file_name, mime, size, created_at, active, year, approval_id, cert_name",
        [id, field("kind") || "Datasheet", field("ref").slice(0, 200), field("title") || f.filename, f.filename, f.mimetype, data.length, data],
      );
      return reply.code(201).send(docFromRow(r.rows[0]));
    }
    const b = z.object({ kind: t(60), title: t(300), url: z.string().url().max(2000), ref: t(200).optional(), certName: t(200).optional(), approvalId: t(120).optional() }).parse(req.body);
    const r = await db.query(
      "INSERT INTO part_docs(part_id, kind, ref, title, url, cert_name, approval_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, part_id, kind, ref, prefix, suffix, title, url, file_name, mime, size, created_at, active, year, approval_id, cert_name",
      [id, b.kind, b.ref ?? "", b.title, b.url, b.certName ?? "", b.approvalId ?? ""],
    );
    return reply.code(201).send(docFromRow(r.rows[0]));
  });
  // Product-series documents (manufacturer + product series; listed under every part of the series)
  const SeriesQ = z.object({ mfr: z.string().trim().min(1).max(200), series: z.string().trim().min(1).max(200) });
  app.get("/api/series-docs", async (req) => {
    const q = SeriesQ.parse(req.query);
    return (await db.query(`SELECT d.id, d.part_id, d.kind, d.ref, d.prefix, d.suffix, d.title, d.url, d.file_name, d.mime, d.size, d.created_at, d.active, d.year, d.series_mfr, d.series_name, d.approval_id, d.cert_name FROM part_docs d WHERE d.series_key = fpl_series_key($1, $2) ORDER BY d.kind, d.created_at`, [q.mfr, q.series])).rows.map(docFromRow);
  });
  app.post("/api/series-docs", async (req, reply) => {
    const RET = "RETURNING id, part_id, kind, ref, prefix, suffix, title, url, file_name, mime, size, created_at, active, year, series_mfr, series_name, approval_id, cert_name";
    if (req.isMultipart()) {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: "No file" });
      const data = await f.toBuffer();
      const field = (k: string) => {
        const v = f.fields[k] as { value?: unknown } | undefined;
        return v && typeof v.value === "string" ? v.value : "";
      };
      const q = SeriesQ.parse({ mfr: field("mfr"), series: field("series") });
      const r = await db.query(
        `INSERT INTO part_docs(series_key, series_mfr, series_name, kind, ref, title, file_name, mime, size, data) VALUES (fpl_series_key($1, $2), $1, $2, $3, $4, $5, $6, $7, $8, $9) ${RET}`,
        [q.mfr, q.series, field("kind") || "Datasheet", field("ref").slice(0, 200), field("title") || f.filename, f.filename, f.mimetype, data.length, data],
      );
      return reply.code(201).send(docFromRow(r.rows[0]));
    }
    const b = SeriesQ.extend({ kind: t(60), title: t(300), url: z.string().url().max(2000), ref: t(200).optional(), certName: t(200).optional(), approvalId: t(120).optional() }).parse(req.body);
    const r = await db.query(
      `INSERT INTO part_docs(series_key, series_mfr, series_name, kind, ref, title, url, cert_name, approval_id) VALUES (fpl_series_key($1, $2), $1, $2, $3, $4, $5, $6, $7, $8) ${RET}`,
      [b.mfr, b.series, b.kind, b.ref ?? "", b.title, b.url, b.certName ?? "", b.approvalId ?? ""],
    );
    return reply.code(201).send(docFromRow(r.rows[0]));
  });
  /**
   * Rename a product series of a manufacturer: every part of that manufacturer + series gets the new name, its
   * product-series documents follow (renaming onto an existing series merges them) and so do the STEP orientations
   * saved for the series. Returns the parts changed.
   */
  app.post("/api/series/rename", async (req) => {
    const b = z.object({ mfr: z.string().trim().min(1).max(200), from: z.string().trim().min(1).max(200), to: z.string().trim().min(1).max(200) }).parse(req.body);
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      const ids = (await c.query("UPDATE parts SET series = $3, updated_at = now() WHERE fpl_series_key(manufacturer, series) = fpl_series_key($1, $2) RETURNING id", [b.mfr, b.from, b.to])).rows.map((r) => String(r.id));
      const docs = (await c.query("UPDATE part_docs SET series_key = fpl_series_key($1, $3), series_name = $3 WHERE series_key = fpl_series_key($1, $2)", [b.mfr, b.from, b.to])).rowCount ?? 0;
      // STEP orientations saved per manufacturer · subcategory · series (Dimensions & 2D views → Apply to series…).
      const o = (await c.query("SELECT id, data FROM ui_presets WHERE scope = 'bom.step-orient' AND name = 'series' FOR UPDATE")).rows[0];
      const nm = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]+/g, "");
      const ns = (x: string) => x.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
      let orients = 0;
      if (o?.data?.rules) {
        const rules = (o.data.rules as { mfr: string; series: string }[]).map((r) => (nm(r.mfr) === nm(b.mfr) && ns(r.series) === ns(b.from) ? (orients++, { ...r, series: b.to }) : r));
        if (orients) await c.query("UPDATE ui_presets SET data = $2, updated_at = now() WHERE id = $1", [o.id, { ...o.data, rules }]);
      }
      for (const id of ids) await syncEffPn(c, id);
      await c.query("COMMIT");
      return { parts: ids.length ? await loadParts(db, ids) : [], docs, orients };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  });
  /** Move a part's document to the part's manufacturer + product series (then listed under every part of the series). */
  app.post("/api/part-docs/:id/to-series", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const r = (await db.query("SELECT p.manufacturer, p.series FROM part_docs d JOIN parts p ON p.id = d.part_id WHERE d.id = $1", [id])).rows[0];
    if (!r) return reply.code(404).send({ error: "Document not found (or already a product-series document)" });
    if (!String(r.series ?? "").trim()) return reply.code(400).send({ error: "The part has no product series" });
    const u = await db.query(
      `UPDATE part_docs SET part_id = NULL, series_key = fpl_series_key($2, $3), series_mfr = $2, series_name = $3 WHERE id = $1
       RETURNING id, part_id, kind, ref, prefix, suffix, title, url, file_name, mime, size, created_at, active, year, series_mfr, series_name, approval_id, cert_name`,
      [id, String(r.manufacturer ?? ""), String(r.series).trim()],
    );
    return docFromRow(u.rows[0]);
  });
  /** Certificate type renamed (Edit part → Documentation → Certificate types…): re-file every certificate of that type. */
  app.post("/api/part-docs/cert-type-rename", async (req) => {
    const b = z.object({ from: z.string().trim().min(1).max(100), to: z.string().trim().min(1).max(100) }).parse(req.body);
    const r = await db.query("UPDATE part_docs SET ref = $2 WHERE ref = $1", [`ctype:${b.from}`, `ctype:${b.to}`]);
    return { updated: r.rowCount ?? 0 };
  });
  /** Number of certificates filed under each type (all parts). */
  app.get("/api/part-docs/cert-type-counts", async () => {
    const r = await db.query("SELECT substr(ref, 7) AS type, count(*)::int AS n FROM part_docs WHERE ref LIKE 'ctype:%' GROUP BY 1");
    return Object.fromEntries(r.rows.map((x) => [x.type, x.n]));
  });
  app.patch("/api/part-docs/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const b = z.object({
      kind: t(60).optional(), title: t(300).optional(), url: z.string().max(2000).optional(), ref: t(200).optional(), prefix: t(80).optional(), suffix: t(80).optional(),
      fileName: z.string().min(1).max(255).regex(/^[^<>:"/\\|?*\x00-\x1f]+$/, "Invalid file name").optional(),
      active: z.boolean().optional(),
      year: z.number().int().min(1900).max(2200).nullable().optional(),
      approvalId: z.string().trim().max(120).optional(),
      certName: z.string().trim().max(200).optional(),
    }).parse(req.body);
    const r = await db.query(
      `UPDATE part_docs SET kind = COALESCE($2, kind), title = COALESCE($3, title), url = COALESCE($4, url), ref = COALESCE($5, ref),
              prefix = COALESCE($6, prefix), file_name = CASE WHEN data IS NULL THEN file_name ELSE COALESCE($7, file_name) END,
              suffix = COALESCE($8, suffix), active = COALESCE($9, active),
              year = CASE WHEN $10 THEN $11::integer ELSE year END, approval_id = COALESCE($12, approval_id), cert_name = COALESCE($13, cert_name) WHERE id = $1`,
      [id, b.kind ?? null, b.title ?? null, b.url ?? null, b.ref ?? null, b.prefix ?? null, b.fileName ?? null, b.suffix ?? null, b.active ?? null, b.year !== undefined, b.year ?? null, b.approvalId ?? null, b.certName ?? null],
    );
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "Not found" });
  });
  app.delete("/api/part-docs/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    await db.query("DELETE FROM part_docs WHERE id = $1", [id]);
    return reply.code(204).send();
  });
  app.get("/api/part-docs/:id/file", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const r = (await db.query("SELECT file_name, mime, data FROM part_docs WHERE id = $1", [id])).rows[0];
    if (!r?.data) return reply.code(404).send({ error: "No file stored for this document" });
    const inline = (req.query as Row)?.inline === "1";
    const name = String(r.file_name || "document");
    // A generic stored type (e.g. a PDF uploaded as application/octet-stream) would make the browser download
    // instead of opening the file in its tab: use the type of the file extension then.
    const ext = (name.match(/\.([A-Za-z0-9]{1,6})$/)?.[1] ?? "").toLowerCase();
    const generic = !r.mime || /^(application\/(octet-stream|x-download|force-download|binary)|binary\/octet-stream)$/i.test(String(r.mime));
    const type = generic ? (DOC_MIME[ext] ?? "application/octet-stream") : String(r.mime);
    return reply
      .header("content-type", type)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\w.\- ()]+/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(r.data);
  });

  /** Downloads of one part (or product series) from Edit part: the documents given, under the names given (folders allowed), links as .url files, with an index. */
  app.post("/api/part-docs/zip", async (req, reply) => {
    const b = z.object({
      name: z.string().min(1).max(150),
      title: z.string().max(300).optional(),
      entries: z.array(z.object({ id: z.string().uuid(), path: z.string().min(1).max(400) })).min(1).max(2000),
      index: z.boolean().default(true),
    }).parse(req.body);
    const rows = new Map((await db.query("SELECT * FROM part_docs WHERE id = ANY($1::uuid[])", [b.entries.map((e) => e.id)])).rows.map((r) => [String(r.id), r]));
    const out: { name: string; data: Buffer | string }[] = [];
    const listed: { folder: string; path: string; d: Row }[] = [];
    for (const e of b.entries) {
      const d = rows.get(e.id);
      if (!d) continue;
      const parts = e.path.split("/").map((x) => safeName(x)).filter(Boolean);
      const path = parts.join("/");
      if (d.data) out.push({ name: path, data: d.data as Buffer });
      else if (d.url) out.push({ name: path, data: urlFile(String(d.url)) });
      else continue;
      listed.push({ folder: parts.slice(0, -1).join("/"), path, d });
    }
    if (b.index && listed.length) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Index");
      const head = ["FOLDER", "KIND", "TYPE / STANDARD", "CERTIFICATE NAME", "TITLE", "APPROVAL ID", "FILE", "LINK"];
      ws.addRow(head).font = { bold: true };
      const link = (c: ExcelJS.Cell, target: string) => ((c.value = { text: String(c.value ?? ""), hyperlink: target }), (c.font = { color: { argb: "FF0563C1" }, underline: true }));
      for (const x of listed) {
        const ref = String(x.d.ref ?? "").replace(/^(cert|ctype):/, "");
        const row = ws.addRow([x.folder, x.d.kind, ref, x.d.cert_name ?? "", x.d.title, x.d.approval_id ?? "", x.path, x.d.url ?? ""]);
        if (x.folder) link(row.getCell(1), `${x.folder}/`);
        link(row.getCell(7), x.path);
        if (x.d.url) link(row.getCell(8), String(x.d.url));
      }
      ws.columns.forEach((c, i) => (c.width = [16, 16, 24, 30, 40, 16, 60, 50][i]));
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } };
      const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
      const href = (p: string) => p.split("/").map(encodeURIComponent).join("/");
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(b.title || b.name)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}th{background:#eee}</style></head><body>
<h2>${esc(b.title || b.name)}</h2><table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>
${listed.map((x) => `<tr><td>${x.folder ? `<a href="${href(x.folder)}/">${esc(x.folder)}</a>` : ""}</td><td>${esc(x.d.kind)}</td><td>${esc(String(x.d.ref ?? "").replace(/^(cert|ctype):/, ""))}</td><td>${esc(x.d.cert_name)}</td><td>${esc(x.d.title)}</td><td>${esc(x.d.approval_id)}</td><td><a href="${href(x.path)}">${esc(x.path)}</a></td><td>${x.d.url ? `<a href="${esc(x.d.url)}">${esc(x.d.url)}</a>` : ""}</td></tr>`).join("\n")}
</table></body></html>`;
      out.unshift({ name: "INDEX.html", data: html }, { name: "INDEX.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()) });
    }
    if (!out.length) return reply.code(400).send({ error: "Nothing to download" });
    return file(reply, `${safeName(b.name)}.zip`, "application/zip", zip(out));
  });

  /** Project documentation package: every stored file of the given parts in a folder per part, plus an index with links. */
  app.post("/api/bom/docs-zip", async (req, reply) => {
    const b = z.object({
      partIds: z.array(z.string().uuid()).max(20000), name: z.string().max(120).default("project-documents"), kinds: z.array(z.string()).optional(),
      /** Project naming convention: files in the package are renamed with it (the stored names are not changed). */
      naming: z.object({
        rules: z.array(z.object({ kind: z.string().max(60), code: z.string().max(20), pattern: z.string().max(300) })).max(100),
        defaultPattern: z.string().max(300), case: z.enum(["upper", "lower", "asis"]), sep: z.enum(["_", "-", " "]), maxLen: z.number().int().min(20).max(250),
      }).nullable().optional(),
      /** Subcategory name per part (for {sub}). */
      subs: z.record(z.string(), z.string().max(200)).optional(),
      /** Manufacturer aliases (for {mfra}). */
      aliases: z.record(z.string(), z.string().max(80)).optional(),
      /** Project-level text added before / after the standard name of every file of a part (e.g. its part line). */
      wrap: z.record(z.string(), z.object({ before: z.string().max(120).optional(), after: z.string().max(120).optional() })).optional(),
      /** BOM part line(s) of each part (index first column). */
      lines: z.record(z.string(), z.string().max(400)).optional(),
      /** Extra index sheets, one per unit of the project BOM (RACK.01, FNE.01 …), with that unit's part lines. */
      units: z.array(z.object({ name: z.string().max(60), partIds: z.array(z.string()).max(20000), lines: z.record(z.string(), z.string().max(400)).optional() })).max(200).optional(),
      /** One folder per BOM part line (item no.) with its files; text around the names per part line. */
      byLine: z.array(z.object({ item: z.string().max(40), unit: z.string().max(60), partId: z.string(), before: z.string().max(120).optional(), after: z.string().max(120).optional() })).max(20000).optional(),
      /** Python key ordering the documents of a part (kind, title, file, std, prefix, suffix, pn, mfr). */
      docOrder: z.string().max(2000).optional(),
    }).parse(req.body);
    const parts = new Map((await loadParts(db, b.partIds)).map((p) => [p.id, p]));
    const order = new Map(b.partIds.map((id, i) => [id, i]));
    let orderError = "";
    const docKey = (d: Row, p: Part | undefined): PyValue => {
      if (!b.docOrder?.trim()) return null;
      const scope: PyScope = {
        kind: String(d.kind ?? ""), title: String(d.title ?? ""), file: String(d.file_name ?? ""), std: String(d.ref ?? "").replace(/^cert:/, ""),
        prefix: String(d.prefix ?? ""), suffix: String(d.suffix ?? ""), pn: p?.partNumber ?? "", mfr: p?.manufacturer ?? "", link: String(d.url ?? ""),
      };
      try {
        const src = b.docOrder.trim();
        return (/\breturn\b|\n/.test(src) ? execCode(src, scope) : evalNode(parseExpr(src), scope)) as PyValue;
      } catch (e) {
        orderError ||= (e as Error).message;
        return null;
      }
    };
    // Only active documents go into the package.
    // (product-series documents are listed under every part of the series)
    const raw = (await db.query(`SELECT d.*, p.id AS part_id FROM parts p JOIN part_docs d ON d.part_id = p.id OR d.series_key = fpl_series_key(p.manufacturer, p.series)
      WHERE p.id = ANY($1::uuid[]) AND d.active ORDER BY d.kind, d.created_at`, [b.partIds])).rows.filter((d) => !b.kinds?.length || b.kinds.includes(d.kind));
    const keyed = raw.map((d, i) => ({ d, i, k: docKey(d, parts.get(d.part_id)) }));
    keyed.sort((x, y) => (order.get(x.d.part_id) ?? 0) - (order.get(y.d.part_id) ?? 0) || (b.docOrder?.trim() ? compareKeys(x.k, y.k) : 0) || x.i - y.i);
    const docs = keyed.map((x) => x.d);
    const entries: { name: string; data: Buffer | string }[] = [];
    // File names: the naming standard of Edit part (sent by the client), with the project prefix / suffix — never the uploaded names.
    const naming = (b.naming as NamingStandard | null | undefined) ?? DEFAULT_NAMING;
    const nameDocs = (p: Part, mine: Row[], w: { before?: string; after?: string }): string[] =>
      partDocNames(naming, mine.map((d) => ({ kind: String(d.kind ?? ""), title: String(d.title ?? ""), fileName: String(d.file_name || ""), prefix: String(d.prefix ?? ""), suffix: String(d.suffix ?? ""), ref: String(d.ref ?? ""), year: d.year == null ? null : Number(d.year) })), { ...p, mfrAlias: aliasOf(b.aliases, p.manufacturer) }, b.subs?.[p.id], w);
    type DocCell = { kind: string; title: string; folder: string; path: string; url: string; ref: string };
    type Row2 = { line: string; unit: string; p: Part; docs: DocCell[] };
    const rows: Row2[] = [];
    if (b.byLine?.length) {
      // One folder per part line: "A2.1 DELL R650", the part's files named for that line.
      for (const l of b.byLine) {
        const p = parts.get(l.partId);
        if (!p) continue;
        const mine = docs.filter((d) => d.part_id === p.id);
        const names = nameDocs(p, mine, { before: l.before, after: l.after });
        const folder = safeName(`${l.item} ${p.manufacturer} ${p.partNumber}`.trim());
        const cells = mine.map((d, i) => docEntry(d, folder, names[i], entries));
        rows.push({ line: l.item, unit: l.unit, p, docs: cells });
      }
    } else {
      for (const p of [...parts.values()].sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0))) {
        const mine = docs.filter((d) => d.part_id === p.id);
        const names = nameDocs(p, mine, b.wrap?.[p.id] ?? {});
        const folder = safeName(`${p.manufacturer} ${p.partNumber}`);
        const cells = mine.map((d, i) => docEntry(d, folder, names[i], entries));
        rows.push({ line: b.lines?.[p.id] ?? "", unit: "", p, docs: cells });
      }
    }

    const wb = new ExcelJS.Workbook();
    const linkCell = (c: ExcelJS.Cell, target: string) => {
      c.value = { text: String(c.value ?? ""), hyperlink: target };
      c.font = { color: { argb: "FF0563C1" }, underline: true };
    };
    // Kinds in the order of the documents (Python order), then the slots each kind needs (a part with 2 manuals → Manual, Manual 2).
    const kindSlots: { kind: string; n: number }[] = [];
    for (const r of rows) {
      const count = new Map<string, number>();
      for (const d of r.docs) {
        const n = (count.get(d.kind) ?? 0) + 1;
        count.set(d.kind, n);
        if (!kindSlots.some((k) => k.kind === d.kind && k.n === n)) kindSlots.push({ kind: d.kind, n });
      }
    }
    const kindOrder = [...new Set(docs.map((d) => String(d.kind)))];
    kindSlots.sort((x, y) => kindOrder.indexOf(x.kind) - kindOrder.indexOf(y.kind) || x.n - y.n);
    /** Index sheet: one row per part line (or part), with KIND / TITLE / FOLDER / FILE IN PACKAGE for every document type (wide) or one row per document (long). */
    const sheet = (name: string, list: Row2[], lines?: Record<string, string>) => {
      const ws = wb.addWorksheet(name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31));
      if (b.byLine?.length) {
        const head = ["PART LINE", "UNIT", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", ...kindSlots.flatMap((k) => {
          const t = `${k.kind.toUpperCase()}${k.n > 1 ? ` ${k.n}` : ""}`;
          return [`${t} · KIND`, `${t} · TITLE`, `${t} · FOLDER`, `${t} · FILE IN PACKAGE`];
        })];
        ws.addRow(head).font = { bold: true };
        for (const r of list) {
          const vals: string[] = [r.line, r.unit, r.p.manufacturer, r.p.partNumber, r.p.description];
          const links: [number, string][] = [];
          for (const k of kindSlots) {
            const d = r.docs.filter((x) => x.kind === k.kind)[k.n - 1];
            const col = vals.length + 1;
            vals.push(d?.kind ?? "", d ? d.title + (d.ref ? ` (${d.ref})` : "") : "", d?.folder ?? "", d?.path || d?.url || "");
            if (d?.path) links.push([col, d.path], [col + 3, d.path]);
            else if (d?.url) links.push([col, d.url], [col + 3, d.url]);
            if (d?.folder) links.push([col + 2, `${d.folder}/`]);
          }
          const row = ws.addRow(vals);
          for (const [c, t] of links) linkCell(row.getCell(c), t);
        }
        ws.columns.forEach((c, i) => (c.width = i < 5 ? [12, 12, 22, 22, 46][i] : [12, 30, 30, 50][(i - 5) % 4]));
        ws.views = [{ state: "frozen", xSplit: 4, ySplit: 1 }];
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } };
        return;
      }
      const head = ["PART LINE", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "KIND", "FOR", "TITLE", "FOLDER", "FILE IN PACKAGE", "LINK"];
      ws.addRow(head).font = { bold: true };
      for (const r of list) {
        const line = lines?.[r.p.id] ?? r.line;
        if (!r.docs.length) ws.addRow([line, r.p.manufacturer, r.p.partNumber, r.p.description, "", "", "(no documents)", "", "", ""]);
        for (const d of r.docs) {
          const row = ws.addRow([line, r.p.manufacturer, r.p.partNumber, r.p.description, d.kind, d.ref, d.title, d.folder, d.path, d.url]);
          if (d.path && d.kind) linkCell(row.getCell(5), d.path);
          if (d.folder) linkCell(row.getCell(8), `${d.folder}/`);
          if (d.url) linkCell(row.getCell(10), d.url);
        }
      }
      ws.columns.forEach((c, i) => (c.width = [12, 22, 22, 50, 14, 14, 36, 34, 60, 40][i] ?? 16));
      ws.views = [{ state: "frozen", ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } };
    };
    sheet("Index", rows);
    for (const u of b.units ?? []) {
      const ids = new Set(u.partIds);
      sheet(u.name || "Unit", b.byLine?.length ? rows.filter((r) => r.unit === u.name) : rows.filter((r) => ids.has(r.p.id)), u.lines);
    }
    if (orderError) {
      const ws = wb.addWorksheet("Notes");
      ws.addRow([`Document order: ${orderError} — documents kept in their default order.`]);
    }
    entries.unshift({ name: "INDEX.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()) });
    const csvRows: string[][] = [["PART LINE", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "KIND", "FOR", "TITLE", "FOLDER", "FILE IN PACKAGE", "LINK"]];
    for (const r of rows) for (const d of r.docs.length ? r.docs : [null]) csvRows.push([r.line, r.p.manufacturer, r.p.partNumber, r.p.description, d?.kind ?? "", d?.ref ?? "", d?.title ?? "(no documents)", d?.folder ?? "", d?.path ?? "", d?.url ?? ""]);
    entries.splice(1, 0, { name: "INDEX.csv", data: "﻿" + toCSV(csvRows) });
    return file(reply, `${safeName(b.name)}.zip`, "application/zip", zip(entries));
  });

  /** Styled workbook from grids computed on the client (equipment lists, roll-up, compare, load schedules, tag list). */
  app.post("/api/bom/xlsx", async (req, reply) => {
    const b = z.object({ fileName: z.string().min(1).max(150), sheets: z.array(SheetZ).min(1).max(100) }).parse(req.body);
    return file(reply, b.fileName.endsWith(".xlsx") ? b.fileName : `${b.fileName}.xlsx`, XLSX_TYPE, await styledXlsx(b.sheets));
  });
}
