import { DOC_KINDS, VIEW_NAMES, type PartView, type ViewName } from "@fpl/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AXES, cleanSvg, dxfToSvg, rotateOrientation, stepToViews, type Axis, type Rot } from "../cad.js";
import type { Db } from "../db.js";
import { docFilesFromZip, stepFromZip } from "../zip.js";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null ? null : Number(v));
const viewFromRow = (r: Row): PartView => ({
  partId: String(r.part_id), view: r.view as ViewName, kind: r.kind as PartView["kind"], content: String(r.content ?? ""),
  wMm: num(r.w_mm), hMm: num(r.h_mm), source: String(r.source ?? ""), updatedAt: new Date(r.updated_at as string).toISOString(),
});
const ViewP = z.object({ id: z.string().uuid(), view: z.enum(VIEW_NAMES) });

async function putView(db: Db, partId: string, view: ViewName, v: { kind: "svg" | "image"; content: string; wMm: number | null; hMm: number | null; source: string }) {
  await db.query(
    `INSERT INTO part_views(part_id, view, kind, content, w_mm, h_mm, source, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (part_id, view) DO UPDATE SET kind = EXCLUDED.kind, content = EXCLUDED.content, w_mm = EXCLUDED.w_mm, h_mm = EXCLUDED.h_mm, source = EXCLUDED.source, updated_at = now()`,
    [partId, view, v.kind, v.content, v.wMm, v.hMm, v.source],
  );
}

async function saveStepViews(db: Db, id: string, fileName: string, r: Awaited<ReturnType<typeof stepToViews>>, up: Axis, front: Axis, dims: boolean) {
  for (const v of VIEW_NAMES) await putView(db, id, v, { kind: "svg", content: r.views[v].svg, wMm: r.views[v].wMm, hMm: r.views[v].hMm, source: `${fileName} (${up} up, ${front} front)` });
  if (dims) await db.query(`UPDATE parts SET mech = mech || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify({ widthMm: r.dims.x, heightMm: r.dims.y, depthMm: r.dims.z })]);
}
const isAxis = (a: unknown): a is Axis => AXES.includes(a as Axis);
/**
 * The part's STEP model: the one kept by the last import, else (parts imported before migration 025) the latest STEP
 * stored with its documents, with the orientation read from its views' source text "(+Z up, -Y front)".
 */
async function cadOf(db: Db, id: string): Promise<{ fileName: string; sourceName: string; txtName: string | null; txt: string | null; data: Buffer; up: Axis; front: Axis; stored: boolean } | null> {
  const c = (await db.query("SELECT file_name, data, up, front, source_name, txt_name, txt FROM part_cad WHERE part_id = $1", [id])).rows[0];
  if (c) return { fileName: c.file_name, sourceName: c.source_name || c.file_name, txtName: c.txt_name, txt: c.txt, data: c.data, up: c.up, front: c.front, stored: true };
  const d = (await db.query(
    "SELECT file_name, data FROM part_docs WHERE part_id = $1 AND data IS NOT NULL AND (mime IN ('model/step', 'application/zip') OR file_name ~* '\\.(stp|step|zip)$') ORDER BY created_at DESC",
    [id],
  )).rows;
  const src = String((await db.query("SELECT source FROM part_views WHERE part_id = $1 AND view = 'front'", [id])).rows[0]?.source ?? "");
  const m = src.match(/\(([+-][XYZ]) up, ([+-][XYZ]) front\)/);
  const o = { up: m && isAxis(m[1]) ? m[1] : ("+Z" as Axis), front: m && isAxis(m[2]) ? m[2] : ("-Y" as Axis) };
  for (const x of d) {
    if (/\.zip$/i.test(x.file_name)) {
      try {
        const z = stepFromZip(x.data);
        return { fileName: z.stepName, sourceName: x.file_name, txtName: z.txtName, txt: z.txt, data: z.step, ...o, stored: false };
      } catch {
        continue; // a ZIP without a STEP model
      }
    }
    return { fileName: x.file_name, sourceName: x.file_name, txtName: null, txt: null, data: x.data, ...o, stored: false };
  }
  return null;
}

/** Part 2D views: list / save / delete, and imports from STEP (all six views + x/y/z), DXF and SVG. */
export function viewRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/part-views", async (req) => {
    const { ids } = z.object({ ids: z.string().max(40000).default("") }).parse(req.query);
    const list = ids.split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 1000);
    if (!list.length) return [];
    return (await db.query("SELECT * FROM part_views WHERE part_id = ANY($1::uuid[]) ORDER BY part_id, view", [list])).rows.map(viewFromRow);
  });
  app.put("/api/parts/:id/views/:view", async (req, reply) => {
    const { id, view } = ViewP.parse(req.params);
    const b = z.object({
      kind: z.enum(["svg", "image"]), content: z.string().min(10).max(40_000_000), wMm: z.number().positive().nullable(), hMm: z.number().positive().nullable(), source: z.string().max(300).default(""),
    }).parse(req.body);
    if (b.kind === "image" && !/^data:image\/(png|jpeg|webp);base64,/.test(b.content)) return reply.code(400).send({ error: "Images must be PNG, JPEG or WebP data URLs" });
    const content = b.kind === "svg" ? cleanSvg(b.content).svg : b.content;
    if (!(await db.query("SELECT 1 FROM parts WHERE id = $1", [id])).rowCount) return reply.code(404).send({ error: "Part not found" });
    await putView(db, id, view, { ...b, content });
    return { ok: true };
  });
  app.delete("/api/parts/:id/views/:view", async (req, reply) => {
    const { id, view } = ViewP.parse(req.params);
    await db.query("DELETE FROM part_views WHERE part_id = $1 AND view = $2", [id, view]);
    return reply.code(204).send();
  });

  /** STEP model the views were drawn from (name and orientation), or null. */
  app.get("/api/parts/:id/views/cad", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await cadOf(db, id);
    return c ? { fileName: c.fileName, sourceName: c.sourceName, txtName: c.txtName, txt: c.txt, up: c.up, front: c.front, stored: c.stored } : null;
  });
  /**
   * Rotate the part by 90° as seen from its front view and re-draw all six views from its STEP model
   * (`rot`: z± about the viewing axis, x± about the horizontal axis, y± about the vertical axis; or `orient` absolute;
   * `dims`: also update x/y/z).
   */
  app.post("/api/parts/:id/views/rotate", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const AxisZ = z.enum(AXES as [Axis, ...Axis[]]);
    const b = z.object({
      rot: z.enum(["z+", "z-", "x+", "x-", "y+", "y-"]).optional(), reset: z.boolean().optional(),
      /** Absolute orientation (e.g. the product series' orientation applied to every part of the series). */
      orient: z.object({ up: AxisZ, front: AxisZ }).optional(),
      /** 2 = turn 180° (one re-draw). */
      times: z.union([z.literal(1), z.literal(2)]).default(1),
      dims: z.boolean().default(true),
    }).parse(req.body);
    if (b.orient && b.orient.up[1] === b.orient.front[1]) return reply.code(400).send({ error: "Up and front must be different axes" });
    const c = await cadOf(db, id);
    if (!c) return reply.code(404).send({ error: "No STEP model for this part: import a STEP (.stp) first" });
    let o: { up: Axis; front: Axis } = b.orient ? b.orient : b.reset ? { up: "+Z" as Axis, front: "-Y" as Axis } : { up: c.up, front: c.front };
    if (!b.orient && !b.reset && b.rot) for (let i = 0; i < b.times; i++) o = rotateOrientation(o.up, o.front, b.rot as Rot);
    const r = await stepToViews(c.data, o.up, o.front);
    await saveStepViews(db, id, c.sourceName && c.sourceName !== c.fileName ? `${c.sourceName} › ${c.fileName}` : c.fileName, r, o.up, o.front, b.dims);
    await db.query(
      `INSERT INTO part_cad(part_id, file_name, data, up, front, source_name, txt_name, txt, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (part_id) DO UPDATE SET up = EXCLUDED.up, front = EXCLUDED.front, updated_at = now()`,
      [id, c.fileName, c.data, o.up, o.front, c.sourceName, c.txtName, c.txt],
    );
    return { up: o.up, front: o.front, dims: r.dims, notes: [`${o.up} up, ${o.front} front`, `${r.dims.x} × ${r.dims.y} × ${r.dims.z} mm`] };
  });

  /**
   * multipart: file (.stp/.step, a .zip holding a .stp and its .txt, .dxf, .svg) + fields
   *   view   target view for DXF / SVG (default front)
   *   up, front   STEP orientation: model axis pointing up / out of the front (default +Z / -Y)
   *   dims=1 write the STEP bounding box to the part's x/y/z;  keep=1 also store the STEP file as a "Drawing / CAD" document
   */
  app.post("/api/parts/:id/views/import", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query("SELECT 1 FROM parts WHERE id = $1", [id])).rowCount) return reply.code(404).send({ error: "Part not found" });
    const f = await req.file();
    if (!f) return reply.code(400).send({ error: "No file" });
    const buf = await f.toBuffer();
    const field = (k: string) => {
      const v = f.fields[k] as { value?: unknown } | undefined;
      return v && typeof v.value === "string" ? v.value : "";
    };
    const ext = (f.filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
    const notes: string[] = [];
    if (ext === "stp" || ext === "step" || ext === "zip") {
      const up = (AXES.includes(field("up") as Axis) ? field("up") : "+Z") as Axis;
      const front = (AXES.includes(field("front") as Axis) ? field("front") : "-Y") as Axis;
      // A .zip holding the .stp (and the .txt usually shared with it): the uploaded file name is kept as the source.
      const z = ext === "zip" ? stepFromZip(buf) : null;
      const step = z ? z.step : buf;
      const stepName = z ? z.stepName : f.filename;
      const label = z ? `${f.filename} › ${stepName}` : f.filename;
      const r = await stepToViews(step, up, front);
      await saveStepViews(db, id, label, r, up, front, field("dims") === "1");
      // Kept so the views can be re-drawn when the part is rotated.
      await db.query(
        `INSERT INTO part_cad(part_id, file_name, data, up, front, source_name, txt_name, txt, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (part_id) DO UPDATE SET file_name = EXCLUDED.file_name, data = EXCLUDED.data, up = EXCLUDED.up, front = EXCLUDED.front,
           source_name = EXCLUDED.source_name, txt_name = EXCLUDED.txt_name, txt = EXCLUDED.txt, updated_at = now()`,
        [id, stepName, step, up, front, f.filename, z?.txtName ?? null, z?.txt ?? null],
      );
      if (z) notes.push(`${stepName}${z.txtName ? ` + ${z.txtName}` : " (no .txt in the ZIP)"} from ${f.filename}${z.others ? ` (${z.others} other STEP file${z.others === 1 ? "" : "s"} ignored)` : ""}`);
      if (z) {
        // The files of the ZIP are stored with the part's documents: AutoCAD (.dwg / .dxf …) and PDF / SVG as CAD with
        // suffix 2D, the STEP as CAD with suffix STEP, images as Image. A file stored already (same name and size) is skipped.
        const have = new Set((await db.query("SELECT lower(file_name) AS n, size FROM part_docs WHERE part_id = $1 AND data IS NOT NULL", [id])).rows.map((r) => `${r.n}|${r.size}`));
        let stored = 0, skipped = 0;
        for (const d of docFilesFromZip(buf)) {
          if (have.has(`${d.name.toLowerCase()}|${d.data.length}`)) {
            skipped++;
            continue;
          }
          await db.query("INSERT INTO part_docs(part_id, kind, title, file_name, mime, size, data, suffix) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [id, d.kind, d.name.replace(/\.[^.]+$/, ""), d.name, d.mime, d.data.length, d.data, d.suffix]);
          have.add(`${d.name.toLowerCase()}|${d.data.length}`);
          stored++;
        }
        notes.push(`${stored} file${stored === 1 ? "" : "s"} of the ZIP stored with the part's documents${skipped ? ` (${skipped} already stored)` : ""}`);
      } else if (field("keep") === "1") {
        // A .stp uploaded on its own: stored under its own name (CAD, suffix STEP).
        await db.query("INSERT INTO part_docs(part_id, kind, title, file_name, mime, size, data, suffix) VALUES ($1,$2,$3,$4,$5,$6,$7,'STEP')",
          [id, DOC_KINDS[6], `3D model ${f.filename}`, f.filename, "model/step", buf.length, buf]);
        notes.push("STEP file stored with the part's documents");
      }
      notes.push(`${r.triangles} triangles · ${r.dims.x} × ${r.dims.y} × ${r.dims.z} mm`);
      return { views: [...VIEW_NAMES], dims: r.dims, notes, up, front };
    }
    const view = (VIEW_NAMES as readonly string[]).includes(field("view")) ? (field("view") as ViewName) : "front";
    if (ext === "dxf") {
      const r = dxfToSvg(buf.toString("utf8"));
      await putView(db, id, view, { kind: "svg", content: r.svg, wMm: r.wMm, hMm: r.hMm, source: f.filename });
      if (r.unitsNote) notes.push(r.unitsNote);
      return { views: [view], dims: null, notes };
    }
    if (ext === "svg") {
      const r = cleanSvg(buf.toString("utf8"));
      await putView(db, id, view, { kind: "svg", content: r.svg, wMm: r.wMm, hMm: r.hMm, source: f.filename });
      return { views: [view], dims: null, notes };
    }
    return reply.code(400).send({ error: "Use .stp/.step, .dxf or .svg here (PDF and images are converted in the browser)" });
  });
}
