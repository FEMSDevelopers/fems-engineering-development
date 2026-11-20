import { autoMap, isPointList, validateSource, type ProtocolMap } from "@fpl/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";

const Kind = z.enum(["modbus", "dnp3", "iec104", "generic"]);
const GridZ = z.array(z.array(z.string()));
const IdParam = z.object({ id: z.string().uuid() });

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  headers: string[];
  rows?: string[][];
  row_count: number;
  protocol_map: ProtocolMap;
  created_at: Date;
  updated_at: Date;
}
const toApi = (r: SourceRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  headers: r.headers,
  rowCount: r.row_count,
  protocolMap: r.protocol_map,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.rows ? { rows: r.rows } : {}),
});
const META = "id, name, kind, headers, row_count, protocol_map, created_at, updated_at";

export function sourceRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/sources", async () => {
    const { rows } = await db.query<SourceRow>(`SELECT ${META} FROM sources ORDER BY updated_at DESC`);
    return rows.map(toApi);
  });

  app.get("/api/sources/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await db.query<SourceRow>(`SELECT ${META}, rows FROM sources WHERE id = $1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: "Source not found" });
    return toApi(rows[0]);
  });

  app.post("/api/sources", async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(200), kind: Kind, grid: GridZ.min(1) }).parse(req.body);
    const headers = body.grid[0];
    const data = body.grid.slice(1);
    const map = isPointList(body.kind) ? autoMap(headers, body.kind) : {};
    const { rows } = await db.query<SourceRow>(
      `INSERT INTO sources(name, kind, headers, rows, row_count, protocol_map) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${META}`,
      [body.name, body.kind, JSON.stringify(headers), JSON.stringify(data), data.length, JSON.stringify(map)],
    );
    return reply.code(201).send(toApi(rows[0]));
  });

  app.patch("/api/sources/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        kind: Kind.optional(),
        protocolMap: z.record(z.string(), z.string()).optional(),
        grid: GridZ.min(1).optional(),
      })
      .parse(req.body);
    const cur = (await db.query<SourceRow>(`SELECT ${META} FROM sources WHERE id = $1`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: "Source not found" });
    const kind = body.kind ?? cur.kind;
    const headers = body.grid ? body.grid[0] : cur.headers;
    let map: ProtocolMap = (body.protocolMap as ProtocolMap) ?? cur.protocol_map;
    // Re-guess the declaration when switching to a point-list kind with nothing mapped yet.
    if (isPointList(kind) && !body.protocolMap && (body.kind || body.grid) && !Object.keys(map).length) map = autoMap(headers, kind);
    const sets: string[] = ["updated_at = now()", "kind = $2", "protocol_map = $3"];
    const vals: unknown[] = [id, kind, JSON.stringify(map)];
    if (body.name) {
      vals.push(body.name);
      sets.push(`name = $${vals.length}`);
    }
    if (body.grid) {
      vals.push(JSON.stringify(headers), JSON.stringify(body.grid.slice(1)), body.grid.length - 1);
      sets.push(`headers = $${vals.length - 2}`, `rows = $${vals.length - 1}`, `row_count = $${vals.length}`);
    }
    const { rows } = await db.query<SourceRow>(`UPDATE sources SET ${sets.join(", ")} WHERE id = $1 RETURNING ${META}`, vals);
    return toApi(rows[0]);
  });

  app.delete("/api/sources/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    await db.query("DELETE FROM sources WHERE id = $1", [id]);
    return reply.code(204).send();
  });

  app.get("/api/sources/:id/validation", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const r = (await db.query<SourceRow>(`SELECT ${META}, rows FROM sources WHERE id = $1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: "Source not found" });
    return validateSource(r.kind, [r.headers, ...(r.rows ?? [])], r.protocol_map);
  });
}
