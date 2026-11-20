import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";

/**
 * Shared routes for resources saved as major.minor versions (conditioning profiles and rule sets):
 *   GET    {base}                         list with version summaries
 *   POST   {base}                         create
 *   PATCH  {base}/:id                     rename
 *   DELETE {base}/:id                     delete with all versions
 *   GET    {base}/:id/versions/:maj/:min  full version (data)
 *   PUT    {base}/:id/versions/:maj/:min  save (create or overwrite; keeps notes)
 *   PATCH  {base}/:id/versions/:maj/:min  notes / update notes
 *   DELETE {base}/:id/versions/:maj/:min  delete one version
 */
export function versionedRoutes(
  app: FastifyInstance,
  db: Db,
  o: { base: string; parent: string; child: string; fk: string; extra?: { api: string; col: string; json?: boolean; def?: unknown }[] },
) {
  const extra = o.extra ?? [];
  const IdP = z.object({ id: z.string().uuid() });
  const VerP = IdP.extend({ major: z.coerce.number().int().min(1), minor: z.coerce.number().int().min(1) });
  const extraSel = extra.map((e) => `p.${e.col}`).join(", ");
  const toApi = (r: Record<string, unknown>) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...Object.fromEntries(extra.map((e) => [e.api, r[e.col] ?? null])),
    versions: ((r.versions as Record<string, unknown>[] | null) ?? []).map((v) => ({
      major: v.major,
      minor: v.minor,
      stamp: v.stamp,
      savedAt: v.saved_at,
      notes: v.notes,
      updateNotes: v.update_notes,
      meta: v.meta,
    })),
  });
  const listSql = (where = "") => `
    SELECT p.id, p.name, p.created_at, p.updated_at${extraSel ? ", " + extraSel : ""},
      (SELECT json_agg(json_build_object('major', v.major, 'minor', v.minor, 'stamp', v.stamp, 'saved_at', v.saved_at,
               'notes', v.notes, 'update_notes', v.update_notes, 'meta', v.meta) ORDER BY v.major DESC, v.minor DESC)
         FROM ${o.child} v WHERE v.${o.fk} = p.id) AS versions
    FROM ${o.parent} p ${where} ORDER BY p.updated_at DESC`;

  app.get(o.base, async () => (await db.query(listSql())).rows.map(toApi));

  app.get(`${o.base}/:id`, async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const r = (await db.query(listSql("WHERE p.id = $1"), [id])).rows[0];
    return r ? toApi(r) : reply.code(404).send({ error: "Not found" });
  });

  app.post(o.base, async (req, reply) => {
    const shape: Record<string, z.ZodTypeAny> = { name: z.string().min(1).max(200) };
    for (const e of extra) shape[e.api] = z.any().optional();
    const body = z.object(shape).parse(req.body) as Record<string, unknown>;
    const cols = ["name", ...extra.map((e) => e.col)];
    const vals = [body.name, ...extra.map((e) => (e.json ? JSON.stringify(body[e.api] ?? e.def ?? null) : body[e.api] ?? e.def ?? null))];
    const r = (await db.query(`INSERT INTO ${o.parent}(${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, vals)).rows[0];
    const full = (await db.query(listSql("WHERE p.id = $1"), [r.id])).rows[0];
    return reply.code(201).send(toApi(full));
  });

  // Rename and/or change extra columns (e.g. move an instance to another folder).
  app.patch(`${o.base}/:id`, async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const shape: Record<string, z.ZodTypeAny> = { name: z.string().min(1).max(200).optional() };
    for (const e of extra) shape[e.api] = z.any().optional();
    const body = z.object(shape).parse(req.body) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [id];
    if (body.name !== undefined) (vals.push(body.name), sets.push(`name = $${vals.length}`));
    for (const e of extra) {
      if (!(e.api in body)) continue;
      vals.push(e.json ? JSON.stringify(body[e.api] ?? e.def ?? null) : body[e.api] ?? e.def ?? null);
      sets.push(`${e.col} = $${vals.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: "Nothing to change" });
    const r = await db.query(`UPDATE ${o.parent} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "Not found" });
  });

  app.delete(`${o.base}/:id`, async (req, reply) => {
    const { id } = IdP.parse(req.params);
    await db.query(`DELETE FROM ${o.parent} WHERE id = $1`, [id]);
    return reply.code(204).send();
  });

  app.get(`${o.base}/:id/versions/:major/:minor`, async (req, reply) => {
    const { id, major, minor } = VerP.parse(req.params);
    const v = (await db.query(`SELECT * FROM ${o.child} WHERE ${o.fk} = $1 AND major = $2 AND minor = $3`, [id, major, minor])).rows[0];
    if (!v) return reply.code(404).send({ error: "Version not found" });
    return { major: v.major, minor: v.minor, stamp: v.stamp, savedAt: v.saved_at, notes: v.notes, updateNotes: v.update_notes, meta: v.meta, data: v.data };
  });

  app.put(`${o.base}/:id/versions/:major/:minor`, async (req, reply) => {
    const { id, major, minor } = VerP.parse(req.params);
    const body = z.object({ stamp: z.string().min(1).max(40), data: z.record(z.string(), z.any()), meta: z.record(z.string(), z.any()).optional() }).parse(req.body);
    const parent = await db.query(`SELECT 1 FROM ${o.parent} WHERE id = $1`, [id]);
    if (!parent.rowCount) return reply.code(404).send({ error: "Not found" });
    // (Per-project version tables are views (migration 026): no xmax there, so "created" is checked beforehand.)
    const existed = (await db.query(`SELECT 1 FROM ${o.child} WHERE ${o.fk} = $1 AND major = $2 AND minor = $3`, [id, major, minor])).rowCount;
    const r = await db.query(
      `INSERT INTO ${o.child}(${o.fk}, major, minor, stamp, saved_at, meta, data) VALUES ($1,$2,$3,$4,now(),$5,$6)
       ON CONFLICT (${o.fk}, major, minor) DO UPDATE SET stamp = EXCLUDED.stamp, saved_at = now(), meta = EXCLUDED.meta, data = EXCLUDED.data
       RETURNING saved_at`,
      [id, major, minor, body.stamp, JSON.stringify(body.meta ?? {}), JSON.stringify(body.data)],
    );
    await db.query(`UPDATE ${o.parent} SET updated_at = now() WHERE id = $1`, [id]);
    return { created: !existed, savedAt: r.rows[0].saved_at };
  });

  app.patch(`${o.base}/:id/versions/:major/:minor`, async (req, reply) => {
    const { id, major, minor } = VerP.parse(req.params);
    // meta: merged into the version's metadata; dataSet: top-level keys written into the saved data (e.g. a BOM's stage).
    const body = z.object({
      notes: z.string().max(10000).optional(), updateNotes: z.string().max(10000).optional(),
      meta: z.record(z.string().max(60), z.any()).optional(), dataSet: z.record(z.string().max(60), z.any()).optional(),
    }).parse(req.body);
    const r = await db.query(
      `UPDATE ${o.child} SET notes = COALESCE($4, notes), update_notes = COALESCE($5, update_notes),
              meta = meta || COALESCE($6::jsonb, '{}'::jsonb), data = data || COALESCE($7::jsonb, '{}'::jsonb)
        WHERE ${o.fk} = $1 AND major = $2 AND minor = $3`,
      [id, major, minor, body.notes ?? null, body.updateNotes ?? null, body.meta ? JSON.stringify(body.meta) : null, body.dataSet ? JSON.stringify(body.dataSet) : null],
    );
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "Version not found" });
  });

  app.delete(`${o.base}/:id/versions/:major/:minor`, async (req, reply) => {
    const { id, major, minor } = VerP.parse(req.params);
    await db.query(`DELETE FROM ${o.child} WHERE ${o.fk} = $1 AND major = $2 AND minor = $3`, [id, major, minor]);
    return reply.code(204).send();
  });
}
