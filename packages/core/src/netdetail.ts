import type { Connection, PathHop } from "./dataflow.js";
import type { Device } from "./network.js";

/** An element on a connection's route: an end device, a hop device, a firewall or a custom trajectory. */
export interface NetElem {
  kind: PathHop["kind"];
  /** Device / firewall id; for custom trajectories a key derived from its label. */
  id: string;
  label?: string;
}
export const elemKey = (e: NetElem) => `${e.kind}:${e.id}`;
const customId = (label: string | undefined) => (label ?? "").trim().toLowerCase() || "(custom)";

/** Where a port value lives in a connection, so edits can be written back. */
export type PortRef =
  | { connId: string; at: "client" | "server" }
  | { connId: string; at: "hop"; hop: number; dir: "in" | "out" };

/** One cable between two consecutive elements of a connection's route. */
export interface NetLink {
  aRef: PortRef;
  bRef: PortRef;
  connId: string;
  a: NetElem;
  aPort: string;
  /** a is the connection's client device. */
  aEnd: boolean;
  b: NetElem;
  bPort: string;
  /** b is the connection's server device. */
  bEnd: boolean;
  /** The element uses one port in both directions on this route (In only hop). */
  aSingle?: boolean;
  bSingle?: boolean;
  /** VLANs carried: the end device's VLAN on access links, both ends' VLANs between network elements. */
  vlanIds: string[];
}

/** VLAN used at each end of a connection: its own per-end value when set, otherwise the device's. */
export function endVlans(c: Connection, devices: Map<string, Device>): { client: string | null; server: string | null } {
  const dv = (id: string | null) => (id ? devices.get(id)?.vlanId ?? null : null);
  return {
    client: (c.endNet ? c.clientVlanId : null) || dv(c.fromId),
    server: (c.endNet ? c.serverVlanId : null) || dv(c.toId),
  };
}

interface Step {
  e: NetElem;
  inPort: string;
  outPort: string;
  single?: boolean;
  inRef: PortRef;
  outRef: PortRef;
}
/** The route of a connection as steps: client, each hop, server — with each step's ports and where they are stored. */
function routeSteps(c: Connection): Step[] {
  const cid = c.id;
  return [
      { e: { kind: "device", id: c.fromId! }, inPort: "", outPort: (c.clientPort ?? "").trim(), inRef: { connId: cid, at: "client" }, outRef: { connId: cid, at: "client" } },
      ...(c.path ?? []).map((h, k) => ({
        inRef: { connId: cid, at: "hop" as const, hop: k, dir: "in" as const },
        // A single-port hop keeps its one port in inPort.
        outRef: { connId: cid, at: "hop" as const, hop: k, dir: h.single ? ("in" as const) : ("out" as const) },
        e: h.kind === "custom" ? { kind: "custom" as const, id: customId(h.label), label: h.label?.trim() || "custom trajectory" } : { kind: h.kind, id: h.id },
        inPort: (h.inPort ?? "").trim(),
        outPort: (h.single ? h.inPort : h.outPort ?? "").trim(),
        single: !!h.single,
      })),
      { e: { kind: "device", id: c.toId! }, inPort: (c.serverPort ?? "").trim(), outPort: "", inRef: { connId: cid, at: "server" }, outRef: { connId: cid, at: "server" } },
  ];
}

/** Every cable implied by the connections' paths (client → hops → server). */
export function buildLinks(conns: Connection[], devices: Device[]): NetLink[] {
  const dmap = new Map(devices.map((d) => [d.id, d]));
  const out: NetLink[] = [];
  for (const c of conns) {
    if (!c.fromId || !c.toId) continue;
    const v = endVlans(c, dmap);
    const steps = routeSteps(c);
    for (let i = 0; i + 1 < steps.length; i++) {
      const aEnd = i === 0;
      const bEnd = i + 1 === steps.length - 1;
      const vl = aEnd && bEnd ? [v.client, v.server] : aEnd ? [v.client] : bEnd ? [v.server] : [v.client, v.server];
      out.push({
        aRef: steps[i].outRef,
        bRef: steps[i + 1].inRef,
        connId: c.id,
        a: steps[i].e,
        aPort: steps[i].outPort,
        aEnd,
        b: steps[i + 1].e,
        bPort: steps[i + 1].inPort,
        bEnd,
        aSingle: steps[i].single,
        bSingle: steps[i + 1].single,
        vlanIds: [...new Set(vl.filter((x): x is string => !!x))],
      });
    }
  }
  return out;
}

/** Elements that appear as a hop anywhere (switches, firewalls, custom trajectories). */
export function hopElements(conns: Connection[]): NetElem[] {
  const seen = new Map<string, NetElem>();
  for (const c of conns)
    for (const h of c.path ?? []) {
      const e: NetElem = h.kind === "custom" ? { kind: "custom", id: customId(h.label), label: h.label?.trim() || "custom trajectory" } : { kind: h.kind, id: h.id };
      seen.set(elemKey(e), e);
    }
  return [...seen.values()];
}

export interface PortPeer {
  elem: NetElem;
  port: string;
  /** The peer is the connection's end device (client or server). */
  end: boolean;
  /** VLANs on the cable(s) to this peer. */
  vlanIds: string[];
  connIds: string[];
  /** Where this element's port and the peer's port are stored (one per connection using the cable). */
  selfRefs: PortRef[];
  peerRefs: PortRef[];
}
export interface PortAlloc {
  /** Port name as typed ("" = not specified). */
  port: string;
  peers: PortPeer[];
  vlanIds: string[];
  connIds: string[];
  /** access: one VLAN towards an end device; trunk: several VLANs or a link to another network element. */
  mode: "access" | "trunk";
  /** Left of the drawing (access to end devices) or right (uplinks to network elements). */
  side: "access" | "uplink";
  warnings: string[];
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Port allocation of one network element: every port with the element(s) it is cabled to. */
/** Write a port value into a connection at `ref` (returns an updated copy). */
export function setPortAt(c: Connection, ref: PortRef, value: string): Connection {
  if (ref.at !== "hop") return ref.at === "client" ? { ...c, clientPort: value } : { ...c, serverPort: value };
  const path = (c.path ?? []).map((h, i) => (i === ref.hop ? (ref.dir === "in" ? { ...h, inPort: value } : { ...h, outPort: value }) : h));
  return { ...c, path };
}

export function portAllocation(elem: NetElem, links: NetLink[]): PortAlloc[] {
  const k = elemKey(elem);
  const ports = new Map<string, { peers: Map<string, PortPeer>; vlans: Set<string>; conns: Set<string>; single: boolean }>();
  const add = (port: string, peer: PortPeer, l: NetLink, single: boolean) => {
    const p = ports.get(port) ?? { peers: new Map(), vlans: new Set(), conns: new Set(), single: false };
    p.single ||= single;
    const pk = `${elemKey(peer.elem)}|${peer.port}`;
    const prev = p.peers.get(pk);
    p.peers.set(pk, {
      ...peer,
      end: peer.end || !!prev?.end,
      vlanIds: [...new Set([...(prev?.vlanIds ?? []), ...l.vlanIds])],
      connIds: [...new Set([...(prev?.connIds ?? []), l.connId])],
      selfRefs: [...(prev?.selfRefs ?? []), ...peer.selfRefs],
      peerRefs: [...(prev?.peerRefs ?? []), ...peer.peerRefs],
    });
    l.vlanIds.forEach((v) => p.vlans.add(v));
    p.conns.add(l.connId);
    ports.set(port, p);
  };
  for (const l of links) {
    const base = { vlanIds: [] as string[], connIds: [] as string[] };
    if (elemKey(l.a) === k) add(l.aPort, { ...base, elem: l.b, port: l.bPort, end: l.bEnd, selfRefs: [l.aRef], peerRefs: [l.bRef] }, l, !!l.aSingle);
    if (elemKey(l.b) === k) add(l.bPort, { ...base, elem: l.a, port: l.aPort, end: l.aEnd, selfRefs: [l.bRef], peerRefs: [l.aRef] }, l, !!l.bSingle);
  }
  const out: PortAlloc[] = [];
  for (const [port, p] of ports) {
    const peers = [...p.peers.values()];
    const warnings: string[] = [];
    if (!port) warnings.push("Port not specified in the path");
    // Several elements on one port are drawn as a shared segment split by VLAN (see the detail sheet), so that is not an issue.
    const side = peers.every((x) => x.end && x.elem.kind === "device") ? "access" : "uplink";
    out.push({
      port,
      peers,
      vlanIds: [...p.vlans],
      connIds: [...p.conns],
      mode: side === "access" && p.vlans.size <= 1 ? "access" : "trunk",
      side,
      warnings,
    });
  }
  return out.sort((a, b) => (a.port ? (b.port ? natural(a.port, b.port) : -1) : b.port ? 1 : 0));
}

/**
 * One direction of a connection seen from a main element: from the main element's port, through any hops,
 * to the end device at that end of the connection.
 */
export interface RouteSide {
  connId: string;
  /** toClient: towards the client / master; toServer: towards the server / outstation. */
  dir: "toClient" | "toServer";
  /** The main element's port on this side, and where it is stored. */
  port: string;
  selfRef: PortRef;
  /** VLAN at the main element on this side, and at the end device. */
  mainVlan: string | null;
  endVlan: string | null;
  /** Elements between the main element and the end device, in order going outwards. */
  hops: NetElem[];
  /** End device (always a device) and its port. */
  endId: string;
  endPort: string;
  endRef: PortRef;
  endAt: "client" | "server";
  /** The main element is itself an end of the connection (client or server). */
  mainAt: "client" | "server" | "hop";
}

/** Every route side through `elem`: each connection it is part of, seen towards the client and/or the server. */
export function routeSides(elem: NetElem, conns: Connection[], devices: Device[]): RouteSide[] {
  const dmap = new Map(devices.map((d) => [d.id, d]));
  const k = elemKey(elem);
  const out: RouteSide[] = [];
  for (const c of conns) {
    if (!c.fromId || !c.toId) continue;
    const steps = routeSteps(c);
    const i = steps.findIndex((s) => elemKey(s.e) === k);
    if (i < 0) continue;
    const last = steps.length - 1;
    const v = endVlans(c, dmap);
    const mainAt = i === 0 ? "client" : i === last ? "server" : "hop";
    if (i > 0)
      out.push({
        connId: c.id, dir: "toClient", port: steps[i].inPort, selfRef: steps[i].inRef,
        // A hop forwards the client's traffic on this side; an end device uses its own VLAN.
        mainVlan: mainAt === "server" ? v.server : v.client,
        endVlan: v.client,
        hops: steps.slice(1, i).reverse().map((s) => s.e),
        endId: c.fromId, endPort: steps[0].outPort, endRef: steps[0].outRef, endAt: "client", mainAt,
      });
    if (i < last)
      out.push({
        connId: c.id, dir: "toServer", port: steps[i].outPort, selfRef: steps[i].outRef,
        mainVlan: mainAt === "client" ? v.client : v.server,
        endVlan: v.server,
        hops: steps.slice(i + 1, last).map((s) => s.e),
        endId: c.toId, endPort: steps[last].inPort, endRef: steps[last].inRef, endAt: "server", mainAt,
      });
  }
  return out;
}
