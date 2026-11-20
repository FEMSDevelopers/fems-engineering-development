import type { Connection, Device, DeviceCategory, Firewall, Service, Vlan } from "@fpl/core";
import { api } from "./api";

/** One network version: every sub-tab of the Network page (plus device categories). */
export interface NetSnap {
  services: Service[];
  firewalls: Firewall[];
  vlans: Vlan[];
  devices: Device[];
  categories: DeviceCategory[];
}
const byId = <T extends { id: string }>(l: T[]) => l.slice().sort((a, b) => a.id.localeCompare(b.id));
/** JSON with object keys sorted (stored versions come back from jsonb with keys in a different order). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
/** Stable text of the data for change detection (derived fields such as a device's auto VLAN are left out). */
const netCanon = (d: NetSnap) =>
  stableJson([byId(d.services), byId(d.firewalls), byId(d.vlans), byId(d.devices).map(({ vlanId: _v, ...x }) => x), byId(d.categories ?? [])]);
export const NET_SNAP = {
  storageKey: "fpl.snap.network",
  store: api.networkSnapshots,
  noun: "network",
  canon: netCanon,
  describe: (d: NetSnap) => ({ services: d.services.length, firewalls: d.firewalls.length, vlans: d.vlans.length, devices: d.devices.length }),
};

/** One connection-list version: every connection with its ports, path and per-end VLAN / IP. */
export interface DfSnap {
  connections: Connection[];
}
export const DF_SNAP = {
  storageKey: "fpl.snap.dataflow",
  store: api.dataflowSnapshots,
  noun: "connection list",
  canon: (d: DfSnap) => stableJson(byId(d.connections ?? [])),
  describe: (d: DfSnap) => ({ connections: (d.connections ?? []).length }),
};
