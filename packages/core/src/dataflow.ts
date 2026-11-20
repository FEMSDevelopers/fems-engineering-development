import { isPointList, type Issue } from "./protocol.js";
import { inCidr, parseCidr, parseIp, type Device, type RowIssues, type Vlan } from "./network.js";

export type HeadKind = "none" | "arrow" | "open" | "dot" | "diamond";
export type DashKind = "solid" | "dashed" | "dotted" | "dashdot";

/** How a protocol's connections are drawn in the Data flow diagram. */
export interface ProtocolStyle {
  color: string;
  /** Line width in px (before scale). */
  width: number;
  dash: DashKind;
  /** Head at the From end (client/master side). */
  startHead: HeadKind;
  /** Head at the To end (server/outstation side). */
  endHead: HeadKind;
  /** Overall scale for line width, heads and label. */
  scale: number;
  opacity: number;
}

export type PointListKind = "" | "modbus" | "dnp3" | "iec104";

export interface ProtocolDef {
  id: string;
  name: string;
  alias: string;
  /** Short text used when the protocol is referenced in data flows (diagram labels, lists). */
  dfAlias: string;
  /** Parent protocol (e.g. Modbus TCP → Modbus); filtering on the parent includes its children. */
  parentId: string | null;
  defaultPort: string;
  /** Point-list declaration this protocol uses, if any. */
  pointListKind: PointListKind;
  style: ProtocolStyle;
  sort: number;
}

/** A directional communication: From (client / master / publisher) → To (server / outstation / broker). */
export interface Connection {
  id: string;
  fromId: string | null;
  toId: string | null;
  protocolId: string | null;
  port: string;
  /** Modbus unit ID, DNP3 outstation address or IEC 104 common address. */
  address: string;
  /** Point-list source describing the data exchanged. */
  sourceId: string | null;
  /** MQTT base topic for this data. */
  topic: string;
  bidirectional: boolean;
  notes: string;
  /** Client device's own port (e.g. eth1). */
  clientPort?: string;
  /** Server device's own port. */
  serverPort?: string;
  /** Network path between client and server: first hop = what the client connects to, last hop = what the server connects to. */
  path?: PathHop[];
  /** When true, the VLAN / IP used at each end are set on the connection (a device may have several ports on different segments). */
  endNet?: boolean;
  clientIp?: string;
  clientVlanId?: string | null;
  serverIp?: string;
  serverVlanId?: string | null;
}

/** One element on the route between client and server: a device (switch, router…), a firewall, or a custom
 * network trajectory described in free text (e.g. "Utility WAN / MPLS"), with its in/out ports. */
export interface PathHop {
  kind: "device" | "firewall" | "custom";
  /** Device or firewall id; "" for custom. */
  id: string;
  /** Name / description of a custom network trajectory. */
  label?: string;
  inPort: string;
  outPort: string;
  /** Only one port is used on this hop (e.g. a tap or a one-armed device); outPort is ignored. */
  single?: boolean;
}

export const DEFAULT_STYLE: ProtocolStyle = { color: "#5b6872", width: 2, dash: "solid", startHead: "none", endHead: "arrow", scale: 1, opacity: 1 };

export const ADDRESS_KEY: Record<string, string> = { modbus: "unitId", dnp3: "outstationAddress", iec104: "commonAddress" };
const ADDRESS_RANGE: Record<string, [number, number]> = { modbus: [0, 255], dnp3: [0, 65519], iec104: [1, 65534] };

/** Protocol ids for a filter selection: each selected protocol plus all its descendants. */
export function expandProtocols(selected: string[], protocols: ProtocolDef[]): Set<string> {
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    protocols.filter((p) => p.parentId === id).forEach((c) => add(c.id));
  };
  selected.forEach(add);
  return out;
}

/** Point-list kind, inherited from the parent when not set. */
export function pointListKindOf(p: ProtocolDef | undefined, protocols: ProtocolDef[]): PointListKind {
  let cur = p;
  for (let i = 0; cur && i < 10; i++) {
    if (cur.pointListKind) return cur.pointListKind;
    cur = protocols.find((x) => x.id === cur!.parentId);
  }
  return "";
}

/** Short port tag for diagrams: "Port 1" → P1, "Ethernet 1"/"eth1" → ETH1, "GigabitEthernet1/0/3" → Gi1/0/3. */
export function portAbbr(port: string | undefined): string {
  const s = String(port ?? "").trim();
  if (!s) return "";
  const rules: [RegExp, string][] = [
    [/^port[\s\-_.#]*(\S.*)$/i, "P"],
    [/^(?:eth(?:ernet)?|en)[\s\-_.#]*(\d.*)$/i, "ETH"],
    [/^(?:gigabitethernet|gige?)[\s\-_]*(\d.*)$/i, "Gi"],
    [/^(?:tengigabitethernet|tengig|te)[\s\-_]*(\d.*)$/i, "Te"],
    [/^(?:fastethernet|fa)[\s\-_]*(\d.*)$/i, "Fa"],
    [/^(?:serial|ser)[\s\-_]*(\d.*)$/i, "S"],
    [/^com[\s\-_]*(\d.*)$/i, "COM"],
    [/^lan[\s\-_]*(\d.*)$/i, "LAN"],
    [/^wan[\s\-_]*(\d.*)$/i, "WAN"],
    [/^(?:sfp)[\s\-_]*(\d.*)$/i, "SFP"],
  ];
  let out = s;
  for (const [re, pre] of rules) {
    const m = s.match(re);
    if (m) {
      out = pre + m[1].replace(/\s+/g, "");
      break;
    }
  }
  return out.length > 10 ? out.slice(0, 9) + "…" : out;
}

export const protocolLabel = (p: ProtocolDef | undefined) => (p ? p.dfAlias || p.alias || p.name : "?");

/** "RTAC.01:eth1 → NS.01 (Gi1/3 → Gi1/24) → FW.01 → … → RTAC.10E:eth0" */
export function pathText(c: Connection, nameOf: (kind: PathHop["kind"], id: string | null) => string): string {
  const port = (p?: string) => (p?.trim() ? `:${p.trim()}` : "");
  const hops = (c.path ?? []).map((h) => {
    const ports = (h.single ? [h.inPort] : [h.inPort, h.outPort]).filter((x) => x?.trim()).join(" → ");
    const name = h.kind === "custom" ? `⟨${h.label?.trim() || "custom trajectory"}⟩` : nameOf(h.kind, h.id);
    return `${name}${ports ? ` (${ports})` : ""}`;
  });
  return [`${nameOf("device", c.fromId)}${port(c.clientPort)}`, ...hops, `${nameOf("device", c.toId)}${port(c.serverPort)}`].join(" → ");
}

export function validateConnections(
  conns: Connection[],
  devices: Device[],
  protocols: ProtocolDef[],
  sourceKinds: Record<string, string> = {},
  firewallIds: string[] = [],
  vlans: Vlan[] = [],
): RowIssues {
  const vmap = new Map(vlans.map((v) => [v.id, v]));
  const fws = new Set(firewallIds);
  const out: RowIssues = {};
  const dev = new Map(devices.map((d) => [d.id, d]));
  const pmap = new Map(protocols.map((p) => [p.id, p]));
  const seen = new Map<string, string>();
  for (const c of conns) {
    const is: Issue[] = [];
    const add = (level: Issue["level"], field: string, msg: string) => is.push({ level, row: null, field, msg });
    if (!c.fromId) add("error", "fromId", "No From device");
    else if (!dev.has(c.fromId)) add("error", "fromId", "From device no longer exists");
    if (!c.toId) add("error", "toId", "No To device");
    else if (!dev.has(c.toId)) add("error", "toId", "To device no longer exists");
    if (c.fromId && c.fromId === c.toId) add("error", "toId", "From and To are the same device");
    const p = c.protocolId ? pmap.get(c.protocolId) : undefined;
    if (!c.protocolId) add("error", "protocolId", "No protocol");
    else if (!p) add("error", "protocolId", "Protocol no longer exists");
    if (c.port.trim() && !(/^\d+$/.test(c.port) && +c.port >= 1 && +c.port <= 65535)) add("error", "port", "Port must be 1–65535");
    const kind = pointListKindOf(p, protocols);
    const a = c.address.trim();
    if (a) {
      const r = ADDRESS_RANGE[kind];
      if (!/^\d+$/.test(a)) add("error", "address", "Address must be a whole number");
      else if (r && (+a < r[0] || +a > r[1])) add("error", "address", `${p?.name} address must be ${r[0]}–${r[1]}`);
    }
    if (c.sourceId) {
      const k = sourceKinds[c.sourceId];
      if (k === undefined) add("error", "sourceId", "Point-list source no longer exists");
      else if (!isPointList(k)) add("warn", "sourceId", "Linked source is not a point list");
      else if (kind && k !== kind) add("warn", "sourceId", `Point list is ${k}, protocol expects ${kind}`);
    }
    if (/[#+]/.test(c.topic)) add("error", "topic", "Publish topics cannot contain the wildcards # or +");
    else if (/\s/.test(c.topic)) add("warn", "topic", "Topic contains spaces");
    else if (/^\/|\/$/.test(c.topic)) add("warn", "topic", "Leading or trailing / creates an empty topic level");
    const path = c.path ?? [];
    if (c.endNet) {
      for (const [end, ip, vid] of [["Client", c.clientIp, c.clientVlanId], ["Server", c.serverIp, c.serverVlanId]] as const) {
        const field = end === "Client" ? "clientIp" : "serverIp";
        const n = ip?.trim() ? parseIp(ip) : null;
        if (ip?.trim() && n == null) add("error", field, `${end} IP is not a valid IPv4 address`);
        const v = vid ? vmap.get(vid) : undefined;
        if (vid && vlans.length && !v) add("error", field, `${end} VLAN no longer exists`);
        const cidr = v ? parseCidr(v.subnet) : null;
        if (n != null && cidr && !inCidr(cidr, n)) add("warn", field, `${end} IP is outside VLAN ${v!.vlan} (${v!.subnet})`);
      }
    }
    path.forEach((h, i) => {
      if (h.kind === "custom") {
        if (!h.label?.trim()) add("warn", "path", `Hop ${i + 1} (custom trajectory) has no name`);
        return;
      }
      const ok = h.kind === "firewall" ? fws.has(h.id) : dev.has(h.id);
      if (!ok) add("error", "path", `Hop ${i + 1} no longer exists`);
      if (h.kind === "device" && (h.id === c.fromId || h.id === c.toId)) add("warn", "path", `Hop ${i + 1} is the client or server itself`);
      if (i > 0 && path[i - 1].kind === h.kind && path[i - 1].id === h.id) add("warn", "path", `Hop ${i + 1} repeats the previous hop`);
    });
    const key = [c.fromId, c.toId, c.protocolId, c.port.trim(), a].join("|");
    if (c.fromId && c.toId && c.protocolId) {
      if (seen.has(key)) add("warn", "protocolId", "Duplicate of another connection");
      else seen.set(key, c.id);
    }
    if (is.length) out[c.id] = is;
  }
  return out;
}
