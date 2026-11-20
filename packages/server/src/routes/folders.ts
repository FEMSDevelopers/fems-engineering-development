import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Db } from "../db.js";

/**
 * Departments and folders (app_folders). A department is a folder without parent.
 *   GET    /api/folders                    flat list (with instance counts per folder)
 *   POST   /api/folders                    { name, parentId?, options? }
 *   PATCH  /api/folders/:id                { name?, parentId?, options? }  (no cycles)
 *   POST   /api/folders/reorder            { ids } siblings in order
 *   DELETE /api/folders/:id?instances=move|delete
 *          sub-folders are removed with it; instances in the subtree are refused (409) unless
 *          moved to the parent of the deleted folder (Unfiled for a department) or deleted.
 */
async function inTx(db: Db, f: (c: pg.PoolClient) => Promise<void>) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await f(c);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export function folderRoutes(app: FastifyInstance, db: Db) {
  const IdP = z.object({ id: z.string().uuid() });
  const Opts = z.record(z.string(), z.any());
  const toApi = (r: Record<string, unknown>) => ({
    id: r.id, parentId: r.parent_id ?? null, name: r.name, sort: r.sort, options: r.options ?? {},
    instances: Number(r.instances ?? 0), createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const subtree = async (id: string): Promise<string[]> =>
    (await db.query(`WITH RECURSIVE t AS (SELECT id FROM app_folders WHERE id = $1 UNION ALL SELECT f.id FROM app_folders f JOIN t ON f.parent_id = t.id) SELECT id FROM t`, [id])).rows.map((r) => r.id as string);

  app.get("/api/folders", async () =>
    (await db.query(`SELECT f.*, (SELECT count(*) FROM json_instances i WHERE i.folder_id = f.id) AS instances FROM app_folders f ORDER BY f.sort, f.name`)).rows.map(toApi));

  app.post("/api/folders", async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(200), parentId: z.string().uuid().nullable().optional(), options: Opts.optional() }).parse(req.body);
    if (b.parentId && !(await db.query(`SELECT 1 FROM app_folders WHERE id = $1`, [b.parentId])).rowCount) return reply.code(400).send({ error: "Parent folder not found" });
    const r = (await db.query(
      `INSERT INTO app_folders(parent_id, name, options, sort)
       VALUES ($1, $2, $3, COALESCE((SELECT max(sort) + 1 FROM app_folders WHERE parent_id IS NOT DISTINCT FROM $1), 0)) RETURNING *`,
      [b.parentId ?? null, b.name, JSON.stringify(b.options ?? {})],
    )).rows[0];
    return reply.code(201).send(toApi(r));
  });

  app.post("/api/folders/reorder", async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()) }).parse(req.body);
    await inTx(db, async (c) => {
      for (let i = 0; i < ids.length; i++) await c.query(`UPDATE app_folders SET sort = $2, updated_at = now() WHERE id = $1`, [ids[i], i]);
    });
    return { ok: true };
  });

  app.patch("/api/folders/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(200).optional(), parentId: z.string().uuid().nullable().optional(), options: Opts.optional() }).parse(req.body);
    const cur = (await db.query(`SELECT * FROM app_folders WHERE id = $1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: "Not found" });
    if (b.parentId !== undefined && b.parentId !== null) {
      if ((await subtree(id)).includes(b.parentId)) return reply.code(400).send({ error: "A folder cannot be moved into itself or one of its sub-folders" });
      if (!(await db.query(`SELECT 1 FROM app_folders WHERE id = $1`, [b.parentId])).rowCount) return reply.code(400).send({ error: "Parent folder not found" });
    }
    const moved = b.parentId !== undefined && (b.parentId ?? null) !== (cur.parent_id ?? null);
    const r = (await db.query(
      `UPDATE app_folders SET name = COALESCE($2, name), options = COALESCE($3, options),
         parent_id = CASE WHEN $4 THEN $5::uuid ELSE parent_id END,
         sort = CASE WHEN $4 THEN COALESCE((SELECT max(sort) + 1 FROM app_folders WHERE parent_id IS NOT DISTINCT FROM $5::uuid), 0) ELSE sort END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.options ? JSON.stringify(b.options) : null, moved, b.parentId ?? null],
    )).rows[0];
    return toApi(r);
  });

  app.delete("/api/folders/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const { instances } = z.object({ instances: z.enum(["move", "delete"]).optional() }).parse(req.query);
    const cur = (await db.query(`SELECT * FROM app_folders WHERE id = $1`, [id])).rows[0];
    if (!cur) return reply.code(204).send();
    const ids = await subtree(id);
    const n = Number((await db.query(`SELECT count(*) AS n FROM json_instances WHERE folder_id = ANY($1::uuid[])`, [ids])).rows[0].n);
    if (n && !instances) return reply.code(409).send({ error: `The folder contains ${n} instance(s)`, instances: n, folders: ids.length - 1 });
    await inTx(db, async (c) => {
      if (n && instances === "move") await c.query(`UPDATE json_instances SET folder_id = $2, updated_at = now() WHERE folder_id = ANY($1::uuid[])`, [ids, cur.parent_id ?? null]);
      if (n && instances === "delete") await c.query(`DELETE FROM json_instances WHERE folder_id = ANY($1::uuid[])`, [ids]);
      await c.query(`DELETE FROM app_folders WHERE id = $1`, [id]);
    });
    return reply.code(204).send();
  });
}
