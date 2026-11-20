import { conditionedBlocks, formatName, padOf, type Entry } from "./condition.js";
import { ADDRESS_KEY, pointListKindOf, protocolLabel, type Connection, type ProtocolDef } from "./dataflow.js";
import { isBlankRow, selectColumns } from "./grid.js";
import { inactiveReason, maskString, parseCidr, parseIp, type Device, type Firewall, type Service, type Vlan } from "./network.js";
import { isPointList, normalizePoint, type ProtocolMap } from "./protocol.js";
import { DEFAULT_NAME_RULE, DEFAULT_OPTIONS, type ColumnRules, type ConditionState, type ConvertOptions, type Grid, type NameRule } from "./types.js";
import { verLabel } from "./version.js";

export interface SourceData {
  id: string;
  name: string;
  kind: string;
  headers: string[];
  /** Data rows (no header). */
  rows: string[][];
  protocolMap: ProtocolMap;
}

export interface ProfileData {
  id: string;
  name: string;
  sourceCols: string[];
  version: {
    major: number;
    minor: number;
    cond: (ColumnRules | null)[];
    nameRule: NameRule;
    order: number[];
    opts: Partial<ConvertOptions>;
  };
}

export interface OutputContext {
  services?: Service[];
  firewalls?: Firewall[];
  vlans: Vlan[];
  devices: Device[];
  connections: Connection[];
  protocols: ProtocolDef[];
  sources: Record<string, SourceData>;
  /** Latest conditioning profile per source id. */
  profiles: Record<string, ProfileData>;
}

/** The context without anything disabled: inactive services/firewalls/VLANs, devices under them, and connections touching those devices. */
export function activeOnly(ctx: OutputContext): OutputContext {
  const services = ctx.services ?? [];
  const firewalls = ctx.firewalls ?? [];
  const h = { services, firewalls, vlans: ctx.vlans, devices: ctx.devices };
  const svcOff = new Set(services.filter((s) => s.enabled === false).map((s) => s.id));
  const fwOff = new Set(firewalls.filter((f) => f.enabled === false || (f.serviceId && svcOff.has(f.serviceId))).map((f) => f.id));
  const devices = ctx.devices.filter((d) => !inactiveReason(d, h));
  const ids = new Set(devices.map((d) => d.id));
  return {
    ...ctx,
    services: services.filter((s) => !svcOff.has(s.id)),
    firewalls: firewalls.filter((f) => !fwOff.has(f.id)),
    vlans: ctx.vlans.filter((v) => v.enabled !== false && !(v.firewallId && fwOff.has(v.firewallId))),
    devices,
    connections: ctx.connections.filter((c) => (!c.fromId || ids.has(c.fromId)) && (!c.toId || ids.has(c.toId))),
  };
}

/** The profile's saved rules applied to the source's current rows (columns picked by header name). */
export function profileState(p: ProfileData, s: SourceData): { state: ConditionState; missing: string[] } {
  const { grid, missing } = selectColumns([s.headers, ...s.rows], p.sourceCols);
  return {
    state: {
      grid,
      cond: p.version.cond ?? [],
      nameRule: p.version.nameRule ?? DEFAULT_NAME_RULE,
      order: p.version.order ?? [],
      opts: { ...DEFAULT_OPTIONS, ...p.version.opts, hdr: true, applyCond: true },
    },
    missing,
  };
}

const topicSafe = (s: string) => s.trim().replace(/[#+\s]+/g, "_");
export const pointTopic = (base: string, tag: string) => (base.trim() && tag ? `${base.trim().replace(/\/+$/, "")}/${topicSafe(tag)}` : "");

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** Connections that carry a point list, sorted by device then client. */
export function pointListConnections(ctx: OutputContext): Connection[] {
  const dev = new Map(ctx.devices.map((d) => [d.id, d]));
  return ctx.connections
    .filter((c) => c.sourceId && c.toId && dev.has(c.toId))
    .sort((a, b) => byName(dev.get(a.toId!)!, dev.get(b.toId!)!) || (dev.get(a.fromId ?? "")?.name ?? "").localeCompare(dev.get(b.fromId ?? "")?.name ?? ""));
}

export const connectionTitle = (ctx: OutputContext, c: Connection) => {
  const d = (id: string | null) => ctx.devices.find((x) => x.id === id)?.name || "?";
  return `${d(c.fromId)} → ${d(c.toId)} · ${protocolLabel(ctx.protocols.find((p) => p.id === c.protocolId))}`;
};

// --- customer point list --------------------------------------------------------

export const POINT_LIST_HEADER = [
  "Device", "Device type", "Serial number", "Polled by", "Protocol", "IP address", "Port", "Unit / address", "VLAN",
  "Tag", "Description", "Object", "Address", "Data type", "Scale", "Units", "Access", "MQTT topic",
];

export function buildPointList(ctx: OutputContext): { grid: Grid; notes: string[] } {
  const rows: string[][] = [];
  const notes: string[] = [];
  const dev = new Map(ctx.devices.map((d) => [d.id, d]));
  const vmap = new Map(ctx.vlans.map((v) => [v.id, v]));
  for (const c of pointListConnections(ctx)) {
    const d = dev.get(c.toId!)!;
    const s = ctx.sources[c.sourceId!];
    const label = connectionTitle(ctx, c);
    if (!s) {
      notes.push(`${label}: point-list source is missing`);
      continue;
    }
    if (!isPointList(s.kind)) {
      notes.push(`${label}: source "${s.name}" is not a point list`);
      continue;
    }
    const p = ctx.protocols.find((x) => x.id === c.protocolId);
    const v = d.vlanId ? vmap.get(d.vlanId) : undefined;
    const port = c.port.trim() || p?.defaultPort || "";
    for (const r of s.rows) {
      if (isBlankRow(r)) continue;
      const pt = normalizePoint(s.kind, s.headers, r, s.protocolMap);
      rows.push([
        d.name, d.type, d.serial, dev.get(c.fromId ?? "")?.name ?? "", p?.name ?? "", d.ip, port, c.address, v ? v.vlan : "",
        pt.tag, pt.description, pt.object, pt.address, pt.dataType, pt.scale, pt.units, pt.access, pointTopic(c.topic, pt.tag),
      ]);
    }
  }
  return { grid: [POINT_LIST_HEADER.slice(), ...rows], notes };
}

// --- Source → MQTT configs ------------------------------------------------------

export interface ConnectionConfig {
  connectionId: string;
  text: string;
  notes: string[];
}

export function buildConnectionConfig(ctx: OutputContext, c: Connection): ConnectionConfig {
  const notes: string[] = [];
  const d = ctx.devices.find((x) => x.id === c.toId);
  const client = ctx.devices.find((x) => x.id === c.fromId);
  const p = ctx.protocols.find((x) => x.id === c.protocolId);
  const kind = pointListKindOf(p, ctx.protocols);
  const v = d?.vlanId ? ctx.vlans.find((x) => x.id === d.vlanId) : undefined;
  const s = c.sourceId ? ctx.sources[c.sourceId] : undefined;
  const prof = s ? ctx.profiles[s.id] : undefined;
  const opts: ConvertOptions = { ...DEFAULT_OPTIONS, ...(prof?.version.opts ?? {}) };
  const pad = padOf(opts);
  const indent = opts.indent === "tab" ? "\t" : Number(opts.indent);
  const cidr = v ? parseCidr(v.subnet) : null;
  const num = (x: string) => (/^\d+$/.test(x.trim()) ? Number(x) : x.trim() || null);
  const head = {
    connection: {
      protocol: p?.name ?? null,
      alias: p?.alias || null,
      client: client?.name ?? null,
      bidirectional: c.bidirectional,
    },
    device: {
      name: d?.name ?? null,
      type: d?.type || null,
      serial: d?.serial || null,
      ip: d?.ip ?? null,
      port: num(c.port) ?? num(p?.defaultPort ?? ""),
      [ADDRESS_KEY[kind] ?? "address"]: num(c.address),
    },
    network: v ? { vlan: num(v.vlan), name: v.name, subnet: v.subnet, mask: cidr ? maskString(cidr) : null, gateway: v.gateway || null } : null,
    mqtt: { baseTopic: c.topic || null },
    source: s ? { name: s.name, kind: s.kind, profile: prof ? `${prof.name} v${verLabel(prof.version)}` : null } : null,
  };
  if (!d) notes.push("To device is missing");
  const headText = JSON.stringify(head, null, indent);
  let blocks: string[] = [];
  if (!s) notes.push("No point-list source linked");
  else if (prof) {
    const { state, missing } = profileState(prof, s);
    if (missing.length) notes.push(`Columns missing from the source: ${missing.join(", ")}`);
    const extra = (i: number): Entry[] => {
      const tag = normalizePoint(s.kind, s.headers, s.rows[i] ?? [], s.protocolMap).tag;
      const t = pointTopic(c.topic, tag);
      return t ? [{ j: -1, name: formatName(state, "mqtt_topic"), val: JSON.stringify(t), cls: "s" }] : [];
    };
    blocks = conditionedBlocks(state, pad + pad, extra).map((b) => b.text);
  } else {
    notes.push("No conditioning profile for this source; using standard protocol fields");
    blocks = s.rows
      .filter((r) => !isBlankRow(r))
      .map((r) => {
        const pt = normalizePoint(s.kind, s.headers, r, s.protocolMap);
        const o = { ...pt, mqtt_topic: pointTopic(c.topic, pt.tag) || undefined };
        return JSON.stringify(o, null, indent).split("\n").map((l) => pad + pad + l).join("\n");
      });
  }
  const text = headText.replace(/\n\}$/, "") + `,\n${pad}"points": [\n` + blocks.join(",\n") + (blocks.length ? "\n" : "") + `${pad}]\n}`;
  return { connectionId: c.id, text, notes };
}

/** All point-list connections in one document: { "connections": [ ... ] } */
export function buildAllConfigs(ctx: OutputContext): { text: string; notes: string[] } {
  const list = pointListConnections(ctx).map((c) => ({ c, cfg: buildConnectionConfig(ctx, c) }));
  const pad = "  ";
  const body = list.map(({ cfg }) => cfg.text.split("\n").map((l) => pad + pad + l).join("\n")).join(",\n");
  return {
    text: `{\n${pad}"connections": [\n${body}${list.length ? "\n" : ""}${pad}]\n}`,
    notes: list.flatMap(({ c, cfg }) => cfg.notes.map((n) => `${connectionTitle(ctx, c)}: ${n}`)),
  };
}

// --- IP schema ------------------------------------------------------------------

export interface IpSection {
  service: Service | null;
  firewall: Firewall | null;
  vlan: Vlan | null;
  mask: string;
  devices: (Device & { protocols: string })[];
}

export const IP_SCHEMA_HEADER = ["Service", "Contractor", "Firewall", "VLAN", "VLAN name", "Subnet", "Mask", "Gateway", "Device", "Device type", "Serial number", "IP address", "Protocols", "Notes"];

export function buildIpSchema(ctx: OutputContext): { sections: IpSection[]; grid: Grid; markdown: string } {
  const protoOf = (id: string) => {
    const set = new Set<string>();
    for (const c of ctx.connections) if (c.fromId === id || c.toId === id) set.add(protocolLabel(ctx.protocols.find((p) => p.id === c.protocolId)));
    return [...set].sort().join(", ");
  };
  const withP = (d: Device) => ({ ...d, protocols: protoOf(d.id) });
  const byVlan = new Map<string, Device[]>();
  const none: Device[] = [];
  const ipKey = (d: Device) => parseIp(d.ip) ?? Number.MAX_SAFE_INTEGER;
  for (const d of ctx.devices) {
    if (d.vlanId && ctx.vlans.some((v) => v.id === d.vlanId)) byVlan.set(d.vlanId, [...(byVlan.get(d.vlanId) ?? []), d]);
    else none.push(d);
  }
  const services = ctx.services ?? [];
  const firewalls = ctx.firewalls ?? [];
  const fwOf = (v: Vlan) => (v.firewallId ? firewalls.find((f) => f.id === v.firewallId) ?? null : null);
  const svcOf = (f: Firewall | null) => (f?.serviceId ? services.find((s) => s.id === f.serviceId) ?? null : null);
  // Order: service sort, firewall sort, VLAN sort / ID.
  const rank = (v: Vlan) => {
    const f = fwOf(v);
    const s = svcOf(f);
    return [s ? s.sort : 1e9, s?.name ?? "", f ? f.sort : 1e9, f?.name ?? "", v.sort ?? 0, Number(v.vlan) || 0] as const;
  };
  const cmp = (a: Vlan, b: Vlan) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  };
  const vl = ctx.vlans.slice().sort(cmp);
  const sections: IpSection[] = vl.map((v) => {
    const c = parseCidr(v.subnet);
    const f = fwOf(v);
    return { service: svcOf(f), firewall: f, vlan: v, mask: c ? maskString(c) : "", devices: (byVlan.get(v.id) ?? []).sort((a, b) => ipKey(a) - ipKey(b)).map(withP) };
  });
  if (none.length) sections.push({ service: null, firewall: null, vlan: null, mask: "", devices: none.sort((a, b) => ipKey(a) - ipKey(b)).map(withP) });

  const grid: Grid = [IP_SCHEMA_HEADER.slice()];
  for (const s of sections) {
    const v = s.vlan;
    const top = [s.service?.name ?? "", s.service?.contractor ?? "", s.firewall?.name ?? ""];
    const base = [...top, ...(v ? [v.vlan, v.name, v.subnet, s.mask, v.gateway] : ["", "Unassigned", "", "", ""])];
    if (!s.devices.length) grid.push([...base, "", "", "", "", "", ""]);
    for (const d of s.devices) grid.push([...base, d.name, d.type, d.serial, d.ip, d.protocols, d.notes]);
  }

  const md: string[] = ["# IP Schema", ""];
  const cell = (x: string) => String(x ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (const s of sections) {
    const v = s.vlan;
    const where = [s.service && `${s.service.name}${s.service.contractor ? ` (${s.service.contractor})` : ""}`, s.firewall?.name].filter(Boolean).join(" › ");
    md.push(v ? `## ${where ? where + " › " : ""}VLAN ${v.vlan} — ${v.name || "(unnamed)"}` : "## Unassigned devices", "");
    if (v) md.push(`Subnet ${v.subnet || "—"} · mask ${s.mask || "—"} · gateway ${v.gateway || "—"}${v.notes ? ` · ${v.notes}` : ""}`, "");
    if (!s.devices.length) {
      md.push("_No devices._", "");
      continue;
    }
    md.push("| Device | Type | Serial number | IP address | Protocols | Notes |", "|---|---|---|---|---|---|");
    for (const d of s.devices) md.push(`| ${cell(d.name)} | ${cell(d.type)} | ${cell(d.serial)} | ${cell(d.ip)} | ${cell(d.protocols)} | ${cell(d.notes)} |`);
    md.push("");
  }
  return { sections, grid, markdown: md.join("\n") };
}
