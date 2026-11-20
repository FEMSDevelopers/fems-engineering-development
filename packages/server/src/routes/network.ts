import {
  DEFAULT_STYLE, deviceVlan, validateConnections, validateDevices, validateVlans,
  type Connection, type Device, type DeviceCategory, type Firewall, type PathHop, type ProtocolDef, type Service, type Vlan,
} from "@fpl/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";

type Row = Record<string, unknown>;
type ColType = "text" | "id" | "bool" | "json" | "int" | "color";
/** API field → [column, type] */
type Cols = Record<string, [string, ColType]>;

const SERVICE_COLS: Cols = {
  name: ["name", "text"], kind: ["kind", "text"], contractor: ["contractor", "text"], notes: ["notes", "text"], enabled: ["enabled", "bool"], sort: ["sort", "int"],
  color: ["color", "color"],
};
const FIREWALL_COLS: Cols = {
  name: ["name", "text"], serviceId: ["service_id", "id"], vendorModel: ["vendor_model", "text"], mgmtIp: ["mgmt_ip", "text"],
  serial: ["serial", "text"], notes: ["notes", "text"], enabled: ["enabled", "bool"], sort: ["sort", "int"],
};
const VLAN_COLS: Cols = {
  vlan: ["vlan", "text"], name: ["name", "text"], subnet: ["subnet", "text"], gateway: ["gateway", "text"], notes: ["notes", "text"],
  firewallId: ["firewall_id", "id"], enabled: ["enabled", "bool"], sort: ["sort", "int"],
};
/** vlanId is not editable: it is derived from the IP and the VLAN subnets (scoped to the device's service when set). */
const DEVICE_COLS: Cols = {
  name: ["name", "text"], type: ["type", "text"], model: ["model", "text"], serial: ["serial", "text"], ip: ["ip", "text"], notes: ["notes", "text"],
  serviceId: ["service_id", "id"], categoryId: ["category_id", "id"], enabled: ["enabled", "bool"], sort: ["sort", "int"],
};
const CATEGORY_COLS: Cols = { name: ["name", "text"], color: ["color", "text"], sort: ["sort", "int"] };
const CONNECTION_COLS: Cols = {
  fromId: ["from_device_id", "id"], toId: ["to_device_id", "id"], protocolId: ["protocol_id", "id"], port: ["port", "text"], address: ["address", "text"],
  sourceId: ["source_id", "id"], topic: ["topic", "text"], bidirectional: ["bidirectional", "bool"], notes: ["notes", "text"],
  clientPort: ["client_port", "text"], serverPort: ["server_port", "text"], path: ["path", "json"],
  endNet: ["end_net", "bool"], clientIp: ["client_ip", "text"], clientVlanId: ["client_vlan_id", "id"], serverIp: ["server_ip", "text"], serverVlanId: ["server_vlan_id", "id"],
};

const str = (v: unknown) => String(v ?? "");
const idOrNull = (v: unknown) => (v as string) ?? null;
export const serviceFromRow = (r: Row): Service => ({
  id: str(r.id), name: str(r.name), kind: str(r.kind), contractor: str(r.contractor), notes: str(r.notes), enabled: r.enabled !== false, sort: Number(r.sort ?? 0),
  color: str(r.color),
});
export const firewallFromRow = (r: Row): Firewall => ({
  id: str(r.id), name: str(r.name), serviceId: idOrNull(r.service_id), vendorModel: str(r.vendor_model), mgmtIp: str(r.mgmt_ip), serial: str(r.serial),
  notes: str(r.notes), enabled: r.enabled !== false, sort: Number(r.sort ?? 0),
});
export const vlanFromRow = (r: Row): Vlan => ({
  id: str(r.id), vlan: str(r.vlan), name: str(r.name), subnet: str(r.subnet), gateway: str(r.gateway), notes: str(r.notes),
  firewallId: idOrNull(r.firewall_id), enabled: r.enabled !== false, sort: Number(r.sort ?? 0),
});
export const deviceFromRow = (r: Row): Device => ({
  id: str(r.id), name: str(r.name), type: str(r.type), model: str(r.model), serial: str(r.serial), ip: str(r.ip), vlanId: idOrNull(r.vlan_id), notes: str(r.notes),
  serviceId: idOrNull(r.service_id), categoryId: idOrNull(r.category_id), enabled: r.enabled !== false, sort: Number(r.sort ?? 0),
});
export const categoryFromRow = (r: Row): DeviceCategory => ({ id: str(r.id), name: str(r.name), color: str(r.color) || "#6b7782", sort: Number(r.sort ?? 0) });
export const connectionFromRow = (r: Row): Connection => ({
  id: str(r.id), fromId: idOrNull(r.from_device_id), toId: idOrNull(r.to_device_id), protocolId: idOrNull(r.protocol_id),
  port: str(r.port), address: str(r.address), sourceId: idOrNull(r.source_id), topic: str(r.topic), bidirectional: !!r.bidirectional, notes: str(r.notes),
  clientPort: str(r.client_port), serverPort: str(r.server_port), path: (r.path as PathHop[]) ?? [],
  endNet: !!r.end_net, clientIp: str(r.client_ip), clientVlanId: idOrNull(r.client_vlan_id), serverIp: str(r.server_ip), serverVlanId: idOrNull(r.server_vlan_id),
});
export const protocolFromRow = (r: Row): ProtocolDef => ({
  id: str(r.id), name: str(r.name), alias: str(r.alias), dfAlias: str(r.df_alias), parentId: idOrNull(r.parent_id),
  defaultPort: str(r.default_port), pointListKind: str(r.point_list_kind) as ProtocolDef["pointListKind"],
  style: { ...DEFAULT_STYLE, ...((r.style as object) ?? {}) }, sort: Number(r.sort ?? 0),
});

const ORDER = "ORDER BY sort, created_at";
export async function loadNetwork(db: Db) {
  const services = (await db.query(`SELECT * FROM services ${ORDER}`)).rows.map(serviceFromRow);
  const firewalls = (await db.query(`SELECT * FROM firewalls ${ORDER}`)).rows.map(firewallFromRow);
  const vlans = (await db.query(`SELECT * FROM vlans ${ORDER}`)).rows.map(vlanFromRow);
  const devices = (await db.query(`SELECT * FROM devices ${ORDER}`)).rows.map(deviceFromRow);
  return { services, firewalls, vlans, devices };
}
export async function loadDataflow(db: Db) {
  const connections = (await db.query("SELECT * FROM connections ORDER BY created_at")).rows.map(connectionFromRow);
  const protocols = (await db.query("SELECT * FROM protocols ORDER BY sort, name")).rows.map(protocolFromRow);
  return { connections, protocols };
}

/** Re-derive every device's VLAN from its IP and the current VLAN subnets (scoped to the device's service when set). */
export async function reassignVlans(db: Db) {
  const { vlans, devices, firewalls } = await loadNetwork(db);
  for (const d of devices) {
    const v = deviceVlan(d, vlans, firewalls);
    if (v !== d.vlanId) await db.query("UPDATE devices SET vlan_id = $2 WHERE id = $1", [d.id, v]);
  }
}

const PathHopZ = z
  .object({
    kind: z.enum(["device", "firewall", "custom"]),
    id: z.string().uuid().or(z.literal("")),
    label: z.string().max(200).optional(),
    inPort: z.string().max(100),
    outPort: z.string().max(100),
    single: z.boolean().optional(),
  })
  .refine((h) => (h.kind === "custom" ? true : h.id !== ""), { message: "Device and firewall hops need an id", path: ["id"] });
const typeZ: Record<ColType, z.ZodTypeAny> = {
  text: z.string().max(2000),
  id: z.string().uuid().or(z.literal("")).nullable(),
  bool: z.boolean(),
  int: z.number().int(),
  json: z.array(PathHopZ).max(50),
  color: z.string().regex(/^(#[0-9a-fA-F]{6})?$/),
};

const cleanVal = (t: ColType, v: unknown) => (t === "id" ? (v ? v : null) : t === "json" ? JSON.stringify(v ?? []) : t === "text" || t === "color" ? v ?? "" : v);
const rowZ = (cols: Cols) => z.object({ id: z.string().uuid() }).extend(Object.fromEntries(Object.entries(cols).map(([k, [, t]]) => [k, typeZ[t].optional()])));
type PgClient = import("pg").PoolClient;

/** Insert or update rows by id (ids are kept so references between tables stay valid). */
async function upsertRows(c: PgClient, table: string, cols: Cols, rows: Record<string, unknown>[]) {
  for (const r of rows) {
    const keys = Object.keys(cols).filter((k) => r[k] !== undefined);
    const names = ["id", ...keys.map((k) => cols[k][0])];
    const vals = [r.id, ...keys.map((k) => cleanVal(cols[k][1], r[k]))];
    const set = keys.map((k) => `${cols[k][0]} = EXCLUDED.${cols[k][0]}`).join(", ");
    await c.query(
      `INSERT INTO ${table}(${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (id) DO ${set ? `UPDATE SET ${set}` : "NOTHING"}`,
      vals,
    );
  }
}
async function deleteMissing(c: PgClient, table: string, keep: string[]) {
  const r = await c.query(`DELETE FROM ${table} WHERE NOT (id = ANY($1::uuid[]))`, [keep]);
  return r.rowCount ?? 0;
}
async function inTx<T>(db: Db, f: (c: PgClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await f(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

function crud(app: FastifyInstance, db: Db, o: { base: string; table: string; cols: Cols; map: (r: Row) => unknown; after?: () => Promise<void> }) {
  const IdP = z.object({ id: z.string().uuid() });
  const fieldZ = z.object(Object.fromEntries(Object.entries(o.cols).map(([k, [, t]]) => [k, typeZ[t].optional()])));
  const clean = (k: string, v: unknown) => {
    const t = o.cols[k][1];
    if (t === "id") return v ? v : null;
    if (t === "json") return JSON.stringify(v ?? []);
    if (t === "text" || t === "color") return v ?? "";
    return v;
  };
  const one = async (id: string) => o.map((await db.query(`SELECT * FROM ${o.table} WHERE id = $1`, [id])).rows[0]);
  async function insert(body: Record<string, unknown>) {
    const keys = Object.keys(o.cols).filter((k) => body[k] !== undefined);
    const sql = keys.length
      ? `INSERT INTO ${o.table}(${keys.map((k) => o.cols[k][0]).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`
      : `INSERT INTO ${o.table} DEFAULT VALUES RETURNING id`;
    return (await db.query(sql, keys.map((k) => clean(k, body[k])))).rows[0].id as string;
  }
  app.get(o.base, async () => (await db.query(`SELECT * FROM ${o.table} ${"sort" in o.cols ? ORDER : "ORDER BY created_at"}`)).rows.map(o.map));
  app.post(o.base, async (req, reply) => {
    const body = fieldZ.parse(req.body ?? {}) as Record<string, unknown>;
    // New rows go to the end of the list.
    if ("sort" in o.cols && body.sort === undefined) body.sort = Number((await db.query(`SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM ${o.table}`)).rows[0].n);
    const id = await insert(body);
    await o.after?.();
    return reply.code(201).send(await one(id));
  });
  app.post(`${o.base}/import`, async (req, reply) => {
    const { rows } = z.object({ rows: z.array(fieldZ).max(5000) }).parse(req.body);
    let next = "sort" in o.cols ? Number((await db.query(`SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM ${o.table}`)).rows[0].n) : 0;
    const ids = [];
    for (const r of rows as Record<string, unknown>[]) ids.push(await insert("sort" in o.cols && r.sort === undefined ? { ...r, sort: next++ } : r));
    await o.after?.();
    return reply.code(201).send(await Promise.all(ids.map(one)));
  });
  if ("sort" in o.cols) {
    /** Set the order of a set of rows (e.g. siblings in the tree): sort = position in `ids`. */
    app.post(`${o.base}/reorder`, async (req) => {
      const { ids } = z.object({ ids: z.array(z.string().uuid()).max(5000) }).parse(req.body);
      for (let i = 0; i < ids.length; i++) await db.query(`UPDATE ${o.table} SET sort = $2 WHERE id = $1`, [ids[i], i]);
      return { ok: true };
    });
  }
  app.patch(`${o.base}/:id`, async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const body = fieldZ.parse(req.body) as Record<string, unknown>;
    const keys = Object.keys(o.cols).filter((k) => body[k] !== undefined);
    if (!keys.length) return reply.code(400).send({ error: "Nothing to update" });
    const r = await db.query(`UPDATE ${o.table} SET ${keys.map((k, i) => `${o.cols[k][0]} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...keys.map((k) => clean(k, body[k]))]);
    if (!r.rowCount) return reply.code(404).send({ error: "Not found" });
    await o.after?.();
    return one(id);
  });
  app.delete(`${o.base}/:id`, async (req, reply) => {
    const { id } = IdP.parse(req.params);
    await db.query(`DELETE FROM ${o.table} WHERE id = $1`, [id]);
    await o.after?.();
    return reply.code(204).send();
  });
}

const StyleZ = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().min(0.5).max(12),
  dash: z.enum(["solid", "dashed", "dotted", "dashdot"]),
  startHead: z.enum(["none", "arrow", "open", "dot", "diamond"]),
  endHead: z.enum(["none", "arrow", "open", "dot", "diamond"]),
  scale: z.number().min(0.25).max(4),
  opacity: z.number().min(0.1).max(1),
});
const ProtocolZ = z.object({
  name: z.string().min(1).max(100),
  alias: z.string().max(100),
  dfAlias: z.string().max(20),
  parentId: z.string().uuid().nullable(),
  defaultPort: z.string().max(10),
  pointListKind: z.enum(["", "modbus", "dnp3", "iec104"]),
  style: StyleZ,
  sort: z.number().int(),
});

export function networkRoutes(app: FastifyInstance, db: Db) {
  const after = () => reassignVlans(db);
  crud(app, db, { base: "/api/services", table: "services", cols: SERVICE_COLS, map: serviceFromRow, after });
  crud(app, db, { base: "/api/firewalls", table: "firewalls", cols: FIREWALL_COLS, map: firewallFromRow, after });
  crud(app, db, { base: "/api/vlans", table: "vlans", cols: VLAN_COLS, map: vlanFromRow, after });
  crud(app, db, { base: "/api/devices", table: "devices", cols: DEVICE_COLS, map: deviceFromRow, after });
  crud(app, db, { base: "/api/categories", table: "device_categories", cols: CATEGORY_COLS, map: categoryFromRow });
  crud(app, db, { base: "/api/connections", table: "connections", cols: CONNECTION_COLS, map: connectionFromRow });

  // ---- restore whole snapshots (loaded from /api/network-snapshots or /api/dataflow-snapshots) ----
  /** Replace services, firewalls, VLANs, devices and categories with a snapshot. Devices removed this way take their connections with them. */
  app.post("/api/network/restore", async (req) => {
    const b = z
      .object({
        services: z.array(rowZ(SERVICE_COLS)).max(5000),
        firewalls: z.array(rowZ(FIREWALL_COLS)).max(5000),
        vlans: z.array(rowZ(VLAN_COLS)).max(5000),
        devices: z.array(rowZ(DEVICE_COLS)).max(20000),
        categories: z.array(rowZ(CATEGORY_COLS)).max(500).optional(),
      })
      .parse(req.body);
    const before = Number((await db.query("SELECT count(*) AS n FROM connections")).rows[0].n);
    const removed = await inTx(db, async (c) => {
      if (b.categories) await upsertRows(c, "device_categories", CATEGORY_COLS, b.categories);
      await upsertRows(c, "services", SERVICE_COLS, b.services);
      await upsertRows(c, "firewalls", FIREWALL_COLS, b.firewalls);
      await upsertRows(c, "vlans", VLAN_COLS, b.vlans);
      await upsertRows(c, "devices", DEVICE_COLS, b.devices);
      const n = {
        devices: await deleteMissing(c, "devices", b.devices.map((x) => x.id)),
        vlans: await deleteMissing(c, "vlans", b.vlans.map((x) => x.id)),
        firewalls: await deleteMissing(c, "firewalls", b.firewalls.map((x) => x.id)),
        services: await deleteMissing(c, "services", b.services.map((x) => x.id)),
        categories: b.categories ? await deleteMissing(c, "device_categories", b.categories.map((x) => x.id)) : 0,
      };
      return n;
    });
    await reassignVlans(db);
    const after = Number((await db.query("SELECT count(*) AS n FROM connections")).rows[0].n);
    return { ok: true, removed: { ...removed, connections: before - after } };
  });

  /** Replace the connection list with a snapshot. References to devices / protocols / sources / VLANs that no longer exist are cleared. */
  app.post("/api/connections/restore", async (req) => {
    const b = z.object({ connections: z.array(rowZ(CONNECTION_COLS)).max(20000) }).parse(req.body);
    const ids = async (t: string) => new Set((await db.query(`SELECT id FROM ${t}`)).rows.map((r) => r.id as string));
    const [dev, prot, src, vl] = await Promise.all([ids("devices"), ids("protocols"), ids("sources"), ids("vlans")]);
    let cleared = 0;
    const fix = (v: unknown, set: Set<string>) => {
      if (v && !set.has(v as string)) {
        cleared++;
        return null;
      }
      return v;
    };
    const rows: Record<string, unknown>[] = (b.connections as Record<string, unknown>[]).map((r) => ({
      ...r,
      fromId: fix(r.fromId, dev),
      toId: fix(r.toId, dev),
      protocolId: fix(r.protocolId, prot),
      sourceId: fix(r.sourceId, src),
      clientVlanId: fix(r.clientVlanId, vl),
      serverVlanId: fix(r.serverVlanId, vl),
    }));
    const removed = await inTx(db, async (c) => {
      await upsertRows(c, "connections", CONNECTION_COLS, rows);
      return deleteMissing(c, "connections", rows.map((x) => x.id as string));
    });
    return { ok: true, restored: rows.length, removed, cleared };
  });

  app.get("/api/network/validation", async () => {
    const { vlans, devices, firewalls } = await loadNetwork(db);
    const { connections, protocols } = await loadDataflow(db);
    const kinds = Object.fromEntries((await db.query("SELECT id, kind FROM sources")).rows.map((r) => [r.id, r.kind]));
    return {
      vlans: validateVlans(vlans, firewalls),
      devices: validateDevices(devices, vlans, firewalls),
      connections: validateConnections(connections, devices, protocols, kinds, firewalls.map((f) => f.id), vlans),
    };
  });

  // ---- saved UI presets (shared) ---------------------------------------------
  app.get("/api/presets", async (req) => {
    const { scope } = z.object({ scope: z.string().min(1).max(100) }).parse(req.query);
    return (await db.query("SELECT id, name, data, updated_at FROM ui_presets WHERE scope = $1 ORDER BY name", [scope])).rows.map((r) => ({ id: r.id, name: r.name, data: r.data, updatedAt: r.updated_at }));
  });
  app.put("/api/presets", async (req) => {
    const b = z.object({ scope: z.string().min(1).max(100), name: z.string().min(1).max(100), data: z.record(z.string(), z.any()) }).parse(req.body);
    const r = await db.query(
      `INSERT INTO ui_presets(scope, name, data) VALUES ($1, $2, $3)
       ON CONFLICT (scope, name) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING id`,
      [b.scope, b.name.trim(), JSON.stringify(b.data)],
    );
    return { id: r.rows[0].id };
  });
  app.delete("/api/presets/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db.query("DELETE FROM ui_presets WHERE id = $1", [id]);
    return reply.code(204).send();
  });

  // ---- protocol catalog -------------------------------------------------------
  const IdP = z.object({ id: z.string().uuid() });
  const COLS: Record<string, string> = { name: "name", alias: "alias", dfAlias: "df_alias", parentId: "parent_id", defaultPort: "default_port", pointListKind: "point_list_kind", style: "style", sort: "sort" };
  const val = (k: string, v: unknown) => (k === "style" ? JSON.stringify(v) : v);
  const one = async (id: string) => protocolFromRow((await db.query("SELECT * FROM protocols WHERE id = $1", [id])).rows[0]);

  /** Refuse a parent that would create a loop (a protocol under its own descendant). */
  async function badParent(id: string | null, parentId: string | null | undefined) {
    if (!parentId) return false;
    if (parentId === id) return true;
    const { protocols } = await loadDataflow(db);
    let cur = protocols.find((p) => p.id === parentId);
    for (let i = 0; cur && i < 50; i++) {
      if (cur.id === id) return true;
      cur = protocols.find((p) => p.id === cur!.parentId);
    }
    return false;
  }

  app.get("/api/protocols", async () => (await loadDataflow(db)).protocols);
  app.post("/api/protocols", async (req, reply) => {
    const b = ProtocolZ.partial({ alias: true, dfAlias: true, parentId: true, defaultPort: true, pointListKind: true, style: true, sort: true }).parse(req.body);
    if (await badParent(null, b.parentId)) return reply.code(400).send({ error: "Invalid parent" });
    const keys = Object.keys(COLS).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    const r = await db.query(
      `INSERT INTO protocols(${keys.map((k) => COLS[k]).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      keys.map((k) => val(k, (b as Record<string, unknown>)[k])),
    );
    return reply.code(201).send(await one(r.rows[0].id));
  });
  app.patch("/api/protocols/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const b = ProtocolZ.partial().parse(req.body) as Record<string, unknown>;
    if (await badParent(id, b.parentId as string | null | undefined)) return reply.code(400).send({ error: "A protocol can't be placed under itself or its own children" });
    const keys = Object.keys(COLS).filter((k) => b[k] !== undefined);
    if (!keys.length) return reply.code(400).send({ error: "Nothing to update" });
    const r = await db.query(`UPDATE protocols SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...keys.map((k) => val(k, b[k]))]);
    return r.rowCount ? one(id) : reply.code(404).send({ error: "Not found" });
  });
  app.delete("/api/protocols/:id", async (req, reply) => {
    const { id } = IdP.parse(req.params);
    const n = Number((await db.query("SELECT count(*) FROM connections WHERE protocol_id = $1", [id])).rows[0].count);
    if (n) return reply.code(409).send({ error: `Used by ${n} connection${n === 1 ? "" : "s"}; change those connections first` });
    await db.query("DELETE FROM protocols WHERE id = $1", [id]);
    return reply.code(204).send();
  });
}
