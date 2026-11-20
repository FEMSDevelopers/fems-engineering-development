import type { Issue } from "./protocol.js";

export const SERVICE_KINDS = ["Substation", "EMS", "QSE", "ISO", "SCADA", "DAS", "PLC", "Other"] as const;

/** A distinct network/solution within the project (e.g. the substation integrator's network), usually by one contractor. */
export interface Service {
  id: string;
  name: string;
  kind: string;
  contractor: string;
  notes: string;
  enabled: boolean;
  sort: number;
  /** Colour used for this service's devices in the Data flow diagram ("" = automatic). */
  color?: string;
}

/** Automatic service colours, used until a colour is chosen. */
export const SERVICE_PALETTE = ["#2f7f8a", "#5b4fc4", "#c46a1f", "#3d8b3d", "#b8417a", "#1f6fc4", "#8a6d2f", "#6b7782"];
export function serviceColor(s: Service | undefined, services: Service[]): string {
  if (!s) return "#6b7782";
  if (s.color && /^#[0-9a-fA-F]{6}$/.test(s.color)) return s.color;
  const i = services.slice().sort((a, b) => a.sort - b.sort).findIndex((x) => x.id === s.id);
  return SERVICE_PALETTE[(i < 0 ? 0 : i) % SERVICE_PALETTE.length];
}

/** A firewall belonging to a service; VLANs sit behind it. */
export interface Firewall {
  id: string;
  name: string;
  serviceId: string | null;
  vendorModel: string;
  mgmtIp: string;
  serial: string;
  notes: string;
  enabled: boolean;
  sort: number;
}

export interface Vlan {
  id: string;
  vlan: string;
  name: string;
  subnet: string;
  gateway: string;
  notes: string;
  firewallId?: string | null;
  enabled?: boolean;
  sort?: number;
}

/** User-editable device grouping (Network, Operational, Workstations, Sensors, Others …) used for filtering. */
export interface DeviceCategory {
  id: string;
  name: string;
  color: string;
  sort: number;
}

/** A physical/logical device. Protocols and point lists live on connections (Data flow), not here. */
export interface Device {
  id: string;
  name: string;
  type: string;
  /** Make / model (e.g. SEL-3530 RTAC). */
  model?: string;
  serial: string;
  ip: string;
  /** Assigned automatically from the VLAN whose subnet contains the IP. */
  vlanId: string | null;
  notes: string;
  /** Optional: limits automatic VLAN matching to this service's VLANs (external networks often reuse subnets). */
  serviceId?: string | null;
  categoryId?: string | null;
  enabled?: boolean;
  sort?: number;
}

export function parseIp(s: string): number | null {
  const m = String(s).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
export const ipToString = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

export interface Cidr {
  network: number;
  broadcast: number;
  bits: number;
  mask: number;
}
export function parseCidr(s: string): Cidr | null {
  const m = String(s).trim().match(/^(.+)\/(\d{1,2})$/);
  if (!m) return null;
  const ip = parseIp(m[1]);
  const bits = Number(m[2]);
  if (ip == null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, broadcast, bits, mask };
}
export const maskString = (c: Cidr) => ipToString(c.mask);
export const inCidr = (c: Cidr, ip: number) => ((ip & c.mask) >>> 0) === c.network;

/** The VLAN whose subnet contains the IP (most specific subnet wins), or null. */
export function matchVlan(ip: string, vlans: Vlan[]): string | null {
  const n = parseIp(ip);
  if (n == null) return null;
  let best: { id: string; bits: number } | null = null;
  for (const v of vlans) {
    const c = parseCidr(v.subnet);
    if (c && inCidr(c, n) && (!best || c.bits > best.bits)) best = { id: v.id, bits: c.bits };
  }
  return best?.id ?? null;
}

/** VLANs that sit behind a firewall of the given service. */
export function vlansOfService(serviceId: string, vlans: Vlan[], firewalls: Firewall[]): Vlan[] {
  const fw = new Set(firewalls.filter((f) => f.serviceId === serviceId).map((f) => f.id));
  return vlans.filter((v) => v.firewallId && fw.has(v.firewallId));
}

/** Auto VLAN for a device: scoped to its service when it has one. */
export function deviceVlan(d: Pick<Device, "ip" | "serviceId">, vlans: Vlan[], firewalls: Firewall[]): string | null {
  return matchVlan(d.ip, d.serviceId ? vlansOfService(d.serviceId, vlans, firewalls) : vlans);
}

export interface Hierarchy {
  services: Service[];
  firewalls: Firewall[];
  vlans: Vlan[];
  devices: Device[];
}

/** The device's chain: VLAN → firewall → service (the service comes from the firewall, or the device's own setting). */
export function chainOf(d: Device, h: Hierarchy) {
  const vlan = d.vlanId ? h.vlans.find((v) => v.id === d.vlanId) : undefined;
  const firewall = vlan?.firewallId ? h.firewalls.find((f) => f.id === vlan.firewallId) : undefined;
  const sid = firewall?.serviceId ?? d.serviceId ?? null;
  const service = sid ? h.services.find((s) => s.id === sid) : undefined;
  return { vlan, firewall, service };
}

/** Why a device is inactive ("" when active): each level from service down to the device must be enabled. */
export function inactiveReason(d: Device, h: Hierarchy): string {
  const { vlan, firewall, service } = chainOf(d, h);
  if (service && service.enabled === false) return `service ${service.name} is inactive`;
  if (firewall && firewall.enabled === false) return `firewall ${firewall.name} is inactive`;
  if (vlan && vlan.enabled === false) return `VLAN ${vlan.vlan} is inactive`;
  if (d.enabled === false) return "device is inactive";
  return "";
}
export const isActive = (d: Device, h: Hierarchy) => !inactiveReason(d, h);

export interface RowIssues {
  [id: string]: Issue[];
}

/** Duplicate VLAN IDs / subnets are only flagged within the same service (external networks may reuse them). */
export function validateVlans(vlans: Vlan[], firewalls: Firewall[] = []): RowIssues {
  const out: RowIssues = {};
  const ids = new Map<string, string>();
  const nets: { id: string; c: Cidr; vlan: string; scope: string }[] = [];
  const fsvc = new Map(firewalls.map((f) => [f.id, f.serviceId ?? ""]));
  for (const v of vlans) {
    const scope = (v.firewallId && fsvc.get(v.firewallId)) || "";
    const is: Issue[] = [];
    const add = (level: Issue["level"], field: string, msg: string) => is.push({ level, row: null, field, msg });
    const id = String(v.vlan).trim();
    if (!/^\d+$/.test(id) || +id < 1 || +id > 4094) add("error", "vlan", "VLAN ID must be 1–4094");
    else if (ids.has(scope + "|" + id)) add("error", "vlan", `VLAN ${id} is defined twice${scope ? " in this service" : ""}`);
    else ids.set(scope + "|" + id, v.id);
    const c = parseCidr(v.subnet);
    if (!v.subnet.trim()) add("warn", "subnet", "No subnet");
    else if (!c) add("error", "subnet", "Subnet must be CIDR, e.g. 10.10.20.0/24");
    else {
      if (parseIp(v.subnet.split("/")[0]) !== c.network) add("warn", "subnet", `Host bits set; network is ${ipToString(c.network)}/${c.bits}`);
      const clash = nets.find((n) => n.scope === scope && n.c.bits === c.bits && n.c.network === c.network);
      if (clash) add("error", "subnet", `Same subnet as VLAN ${clash.vlan}`);
      nets.push({ id: v.id, c, vlan: id, scope });
    }
    if (v.firewallId && firewalls.length && !fsvc.has(v.firewallId)) add("error", "firewallId", "Firewall no longer exists");
    if (v.gateway.trim()) {
      const g = parseIp(v.gateway);
      if (g == null) add("error", "gateway", "Gateway is not a valid IPv4 address");
      else if (c && !inCidr(c, g)) add("error", "gateway", "Gateway is outside the subnet");
      else if (c && (g === c.network || g === c.broadcast)) add("error", "gateway", "Gateway is the network or broadcast address");
    }
    if (is.length) out[v.id] = is;
  }
  return out;
}

export function validateDevices(devices: Device[], vlans: Vlan[], firewalls: Firewall[] = []): RowIssues {
  const out: RowIssues = {};
  const ips = new Map<string, string>();
  const serials = new Map<string, string>();
  const vmap = new Map(vlans.map((v) => [v.id, v]));
  for (const d of devices) {
    const is: Issue[] = [];
    const add = (level: Issue["level"], field: string, msg: string) => is.push({ level, row: null, field, msg });
    if (!d.name.trim()) add("warn", "name", "No name");
    const sn = d.serial.trim();
    if (sn) {
      if (serials.has(sn)) add("warn", "serial", "Serial number used by another device");
      else serials.set(sn, d.id);
    }
    const ip = parseIp(d.ip);
    if (!d.ip.trim()) add("warn", "ip", "No IP address");
    else if (ip == null) add("error", "ip", "Not a valid IPv4 address");
    else {
      if (ips.has(d.ip.trim())) add("error", "ip", "IP address used by another device");
      else ips.set(d.ip.trim(), d.id);
      const vid = deviceVlan(d, vlans, firewalls);
      const v = vid ? vmap.get(vid) : undefined;
      const c = v ? parseCidr(v.subnet) : null;
      if (!v) add("warn", "vlanId", d.serviceId ? "No VLAN of this service contains this IP" : "No VLAN subnet contains this IP");
      else if (c && (ip === c.network || ip === c.broadcast)) add("error", "ip", "Network or broadcast address");
      if (v?.gateway && parseIp(v.gateway) === ip) add("error", "ip", "Same as the VLAN gateway");
    }
    if (is.length) out[d.id] = is;
  }
  return out;
}

export function validateServices(services: Service[]): RowIssues {
  const out: RowIssues = {};
  const names = new Map<string, string>();
  for (const s of services) {
    const is: Issue[] = [];
    const add = (level: Issue["level"], field: string, msg: string) => is.push({ level, row: null, field, msg });
    if (!s.contractor.trim()) add("warn", "contractor", "No contractor");
    const n = s.name.trim().toLowerCase();
    if (!n) add("warn", "name", "No name");
    else if (names.has(n)) add("error", "name", "Another service has this name");
    else names.set(n, s.id);
    if (is.length) out[s.id] = is;
  }
  return out;
}

export function validateFirewalls(firewalls: Firewall[], services: Service[]): RowIssues {
  const out: RowIssues = {};
  const names = new Map<string, string>();
  const sids = new Set(services.map((s) => s.id));
  for (const f of firewalls) {
    const is: Issue[] = [];
    const add = (level: Issue["level"], field: string, msg: string) => is.push({ level, row: null, field, msg });
    const n = f.name.trim().toLowerCase();
    if (!n) add("warn", "name", "No name");
    else if (names.has(n)) add("error", "name", "Another firewall has this name");
    else names.set(n, f.id);
    if (!f.serviceId) add("warn", "serviceId", "No service");
    else if (!sids.has(f.serviceId)) add("error", "serviceId", "Service no longer exists");
    if (f.mgmtIp.trim() && parseIp(f.mgmtIp) == null) add("error", "mgmtIp", "Not a valid IPv4 address");
    if (is.length) out[f.id] = is;
  }
  return out;
}

/** Sort keys that follow the tree: service order → firewall order → VLAN order → own order. Unassigned items sort last. */
export function treeRank(h: Hierarchy) {
  const svc = new Map(h.services.map((s) => [s.id, s]));
  const fw = new Map(h.firewalls.map((f) => [f.id, f]));
  const vl = new Map(h.vlans.map((v) => [v.id, v]));
  const BIG = 1e9;
  const sRank = (id?: string | null) => (id && svc.has(id) ? svc.get(id)!.sort : BIG);
  const fKey = (f?: Firewall): number[] => (f ? [sRank(f.serviceId), f.sort] : [BIG, BIG]);
  const vKey = (v?: Vlan): number[] => (v ? [...fKey(v.firewallId ? fw.get(v.firewallId) : undefined), v.sort ?? 0, Number(v.vlan) || 0] : [BIG, BIG, BIG, BIG]);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  return {
    services: (a: Service, b: Service) => a.sort - b.sort,
    firewalls: (a: Firewall, b: Firewall) => cmp(fKey(a), fKey(b)),
    vlans: (a: Vlan, b: Vlan) => cmp(vKey(a), vKey(b)),
    devices: (a: Device, b: Device) => {
      const v = (d: Device) => (d.vlanId ? vl.get(d.vlanId) : undefined);
      const ka = v(a) ? vKey(v(a)) : [sRank(a.serviceId), BIG, BIG, BIG];
      const kb = v(b) ? vKey(v(b)) : [sRank(b.serviceId), BIG, BIG, BIG];
      return cmp([...ka, a.sort ?? 0], [...kb, b.sort ?? 0]);
    },
  };
}
