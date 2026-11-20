import {
  activeOnly,
  buildAllConfigs, buildConnectionConfig, buildIpSchema, buildPointList, toCSV,
  type Grid, type OutputContext, type ProfileData, type SourceData,
} from "@fpl/core";
import ExcelJS from "exceljs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { loadDataflow, loadNetwork } from "./network.js";

/** Everything the generators need: network objects, linked sources (with rows) and each source's latest profile. */
export async function loadOutputContext(db: Db): Promise<OutputContext> {
  const { services, firewalls, vlans, devices } = await loadNetwork(db);
  const { connections, protocols } = await loadDataflow(db);
  const ids = [...new Set(connections.map((c) => c.sourceId).filter((x): x is string => !!x))];
  const sources: Record<string, SourceData> = {};
  const profiles: Record<string, ProfileData> = {};
  if (ids.length) {
    const rs = await db.query("SELECT id, name, kind, headers, rows, protocol_map FROM sources WHERE id = ANY($1::uuid[])", [ids]);
    for (const r of rs.rows) sources[r.id] = { id: r.id, name: r.name, kind: r.kind, headers: r.headers, rows: r.rows, protocolMap: r.protocol_map };
    // Latest-updated profile per source, and its highest version.
    const ps = await db.query(
      `SELECT DISTINCT ON (p.source_id) p.source_id, p.id, p.name, p.source_cols, v.major, v.minor, v.data
         FROM profiles p JOIN profile_versions v ON v.profile_id = p.id
        WHERE p.source_id = ANY($1::uuid[])
        ORDER BY p.source_id, p.updated_at DESC, v.major DESC, v.minor DESC`,
      [ids],
    );
    for (const r of ps.rows) {
      const d = r.data ?? {};
      profiles[r.source_id] = {
        id: r.id,
        name: r.name,
        sourceCols: r.source_cols ?? d.grid?.[0] ?? [],
        version: { major: r.major, minor: r.minor, cond: d.cond ?? [], nameRule: d.nameRule, order: d.order ?? [], opts: d.opts ?? {} },
      };
    }
  }
  // Disabled services, firewalls, VLANs and devices (and their connections) are left out of every output.
  return activeOnly({ services, firewalls, vlans, devices, connections, protocols, sources, profiles });
}

async function xlsx(grid: Grid, sheet: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  grid.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.columns.forEach((c) => {
    let w = 8;
    c.eachCell?.({ includeEmpty: false }, (cell) => (w = Math.max(w, Math.min(60, String(cell.value ?? "").length + 2))));
    c.width = w;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function file(reply: FastifyReply, name: string, type: string, body: string | Buffer) {
  return reply.header("content-type", type).header("content-disposition", `attachment; filename="${name}"`).send(body);
}

const Fmt = z.object({ format: z.enum(["json", "csv", "xlsx", "md", "file"]).default("json") });

export function outputRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/outputs/pointlist", async (req, reply) => {
    const { format } = Fmt.parse(req.query);
    const { grid, notes } = buildPointList(await loadOutputContext(db));
    if (format === "csv") return file(reply, "point-list.csv", "text/csv; charset=utf-8", "﻿" + toCSV(grid));
    if (format === "xlsx") return file(reply, "point-list.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await xlsx(grid, "Point list"));
    return { grid, notes };
  });

  app.get("/api/outputs/configs", async (req, reply) => {
    const q = Fmt.extend({ connectionId: z.string().uuid().optional() }).parse(req.query);
    const ctx = await loadOutputContext(db);
    let text: string;
    let notes: string[];
    let name = "mqtt-configs.json";
    if (q.connectionId) {
      const c = ctx.connections.find((x) => x.id === q.connectionId);
      if (!c) return reply.code(404).send({ error: "Connection not found" });
      ({ text, notes } = buildConnectionConfig(ctx, c));
      const d = ctx.devices.find((x) => x.id === c.toId);
      const p = ctx.protocols.find((x) => x.id === c.protocolId);
      name = `${[d?.name, p?.dfAlias || p?.alias].filter(Boolean).join("_").replace(/[^\w.-]+/g, "_") || "connection"}.json`;
    } else ({ text, notes } = buildAllConfigs(ctx));
    if (q.format === "file") return file(reply, name, "application/json; charset=utf-8", text);
    return { text, notes };
  });

  app.get("/api/outputs/ipschema", async (req, reply) => {
    const { format } = Fmt.parse(req.query);
    const s = buildIpSchema(await loadOutputContext(db));
    if (format === "csv") return file(reply, "ip-schema.csv", "text/csv; charset=utf-8", "﻿" + toCSV(s.grid));
    if (format === "xlsx") return file(reply, "ip-schema.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await xlsx(s.grid, "IP schema"));
    if (format === "md") return file(reply, "ip-schema.md", "text/markdown; charset=utf-8", s.markdown);
    return s;
  });
}
