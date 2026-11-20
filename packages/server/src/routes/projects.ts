import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { projectCtx, type Db } from "../db.js";

/**
 * Projects (migration 026): list / create / edit / delete, and the current project of each request.
 * A request names its project with the x-fpl-project header (the web app adds it to every /api call), else the
 * fpl_project cookie (direct links and downloads), else ?project=; otherwise the most recently used project.
 */
type Row = Record<string, unknown>;
export const PROJECT_STAGES = ["Proposal", "30%", "60%", "90%", "IFC", "As-built", "Commissioned"] as const;
export const PROJECT_STATES = ["Active", "On hold", "Closed"] as const;

const COLS: [api: string, col: string, kind: "text" | "num"][] = [
  ["name", "name", "text"], ["alias", "alias", "text"], ["country", "country", "text"], ["state", "state", "text"],
  ["contractor", "contractor", "text"], ["endUser", "end_user", "text"], ["iso", "iso", "text"], ["dispatcher", "dispatcher", "text"],
  ["qse", "qse", "text"], ["kw", "kw", "num"], ["kwh", "kwh", "num"], ["pcsOem", "pcs_oem", "text"], ["bessOem", "bess_oem", "text"],
  ["stage", "stage", "text"], ["activeState", "active_state", "text"], ["notes", "notes", "text"],
];
const fromRow = (r: Row) => {
  const o: Row = { id: r.id };
  for (const [a, c, k] of COLS) o[a] = k === "num" ? (r[c] == null ? null : Number(r[c])) : String(r[c] ?? "");
  o.lastUsedAt = r.last_used_at ? new Date(r.last_used_at as string).toISOString() : null;
  o.createdAt = new Date(r.created_at as string).toISOString();
  o.updatedAt = new Date(r.updated_at as string).toISOString();
  return o;
};
const Patch = z.object({
  name: z.string().trim().min(1).max(200), alias: z.string().max(100), country: z.string().max(100), state: z.string().max(100),
  contractor: z.string().max(200), endUser: z.string().max(200), iso: z.string().max(100), dispatcher: z.string().max(200),
  qse: z.string().max(200), kw: z.number().finite().nonnegative().nullable(), kwh: z.number().finite().nonnegative().nullable(),
  pcsOem: z.string().max(200), bessOem: z.string().max(200), stage: z.string().max(50), activeState: z.string().max(50), notes: z.string().max(5000),
}).partial();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function cookie(req: FastifyRequest, name: string): string {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}

export function projectRoutes(app: FastifyInstance, db: Db) {
  // Known project ids (refreshed after every change, and at most every 10 s) and the fallback (most recently used).
  let known = new Set<string>();
  let fallback = "";
  let loadedAt = 0;
  const refresh = async () => {
    const r = await db.query("SELECT id FROM app_projects ORDER BY last_used_at DESC NULLS LAST, created_at");
    known = new Set(r.rows.map((x) => String(x.id)));
    fallback = r.rows[0] ? String(r.rows[0].id) : "";
    loadedAt = Date.now();
  };

  app.addHook("onRequest", (req, _reply, done) => {
    if (!req.url.startsWith("/api/")) return done();
    const pick = async () => {
      if (Date.now() - loadedAt > 10_000) await refresh().catch(() => undefined);
      const asked = [String(req.headers["x-fpl-project"] ?? ""), cookie(req, "fpl_project"), String((req.query as Row)?.project ?? "")].find((x) => UUID.test(x));
      return asked && known.has(asked.toLowerCase()) ? asked.toLowerCase() : fallback;
    };
    pick().then((project) => projectCtx.run({ project }, done), (e) => done(e as Error));
  });

  app.get("/api/projects", async () => (await db.query("SELECT * FROM app_projects ORDER BY lower(name)")).rows.map(fromRow));
  /** The project this request resolved to (the web app asks at start-up). */
  app.get("/api/projects/current", async () => {
    const id = projectCtx.getStore()?.project ?? "";
    const r = id ? (await db.query("SELECT * FROM app_projects WHERE id = $1", [id])).rows[0] : null;
    return r ? fromRow(r) : null;
  });
  app.post("/api/projects", async (req, reply) => {
    const b = Patch.required({ name: true }).parse(req.body);
    const cols = COLS.filter(([a]) => (b as Row)[a] !== undefined);
    const r = await db.query(
      `INSERT INTO app_projects(${cols.map(([, c]) => c).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      cols.map(([a]) => (b as Row)[a]),
    );
    await refresh();
    return reply.code(201).send(fromRow(r.rows[0]));
  });
  app.patch("/api/projects/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = Patch.parse(req.body);
    const cols = COLS.filter(([a]) => (b as Row)[a] !== undefined);
    if (!cols.length) return reply.code(400).send({ error: "Nothing to change" });
    const r = await db.query(
      `UPDATE app_projects SET ${cols.map(([, c], i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...cols.map(([a]) => (b as Row)[a])],
    );
    if (!r.rowCount) return reply.code(404).send({ error: "Project not found" });
    return fromRow(r.rows[0]);
  });
  /** Mark as the most recently used (the fallback for requests that don't name a project). */
  app.post("/api/projects/:id/use", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query("UPDATE app_projects SET last_used_at = now() WHERE id = $1 RETURNING *", [id]);
    if (!r.rowCount) return reply.code(404).send({ error: "Project not found" });
    await refresh();
    return fromRow(r.rows[0]);
  });
  /** Deletes the project and all of its content (sources, network, data flow, project BOMs, layouts…). */
  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ confirmName: z.string() }).parse(req.body ?? {});
    const p = (await db.query("SELECT name FROM app_projects WHERE id = $1", [id])).rows[0];
    if (!p) return reply.code(404).send({ error: "Project not found" });
    if (b.confirmName.trim() !== String(p.name).trim()) return reply.code(400).send({ error: "Type the project name to confirm" });
    if (Number((await db.query("SELECT count(*) AS n FROM app_projects")).rows[0].n) <= 1) return reply.code(400).send({ error: "The last project cannot be deleted" });
    await db.query("DELETE FROM app_projects WHERE id = $1", [id]);
    await refresh();
    return reply.code(204).send();
  });
  /** Item counts of a project (shown in the list; the content of other projects stays invisible). */
  app.get("/api/projects/:id/counts", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = ["sources", "devices", "connections", "bom_projects", "mech_racks", "mech_fnes", "json_instances"];
    const r = await db.query(`SELECT ${t.map((x) => `(SELECT count(*) FROM ${x}_all WHERE app_project_id = $1) AS ${x}`).join(", ")}`, [id]);
    return Object.fromEntries(t.map((x) => [x, Number(r.rows[0][x])]));
  });
}
