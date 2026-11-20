import { inactiveReason, type Device, type Firewall, type Hierarchy, type Service, type Vlan } from "@fpl/core";
import { useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { useLocal, useUi } from "../ui";

type Kind = "service" | "firewall" | "vlan" | "device";
const TABLE: Record<Kind, keyof Hierarchy> = { service: "services", firewall: "firewalls", vlan: "vlans", device: "devices" };
type Item = Service | Firewall | Vlan | Device;

interface Node {
  key: string;
  kind: Kind | "group";
  item?: Item;
  label?: string;
  /** Siblings share this; only same-kind siblings can be reordered together. */
  parent: string;
  children: Node[];
  inactive: string;
}

const bySort = (a: { sort?: number }, b: { sort?: number }) => (a.sort ?? 0) - (b.sort ?? 0);

function build(h: Hierarchy): Node[] {
  const sids = new Set(h.services.map((s) => s.id));
  const fids = new Set(h.firewalls.map((f) => f.id));
  const vids = new Set(h.vlans.map((v) => v.id));
  const off = (x: { enabled?: boolean }, parent: string, what: string) => parent || (x.enabled === false ? `${what} is inactive` : "");

  const devNode = (d: Device, parent: string): Node => ({ key: `device:${d.id}`, kind: "device", item: d, parent, children: [], inactive: inactiveReason(d, h) });
  const vlanNode = (v: Vlan, parent: string, up: string): Node => {
    const inactive = off(v, up, `VLAN ${v.vlan}`);
    const key = `vlan:${v.id}`;
    return { key, kind: "vlan", item: v, parent, inactive, children: h.devices.filter((d) => d.vlanId === v.id).sort(bySort).map((d) => devNode(d, key)) };
  };
  const fwNode = (f: Firewall, parent: string, up: string): Node => {
    const inactive = off(f, up, `firewall ${f.name}`);
    const key = `firewall:${f.id}`;
    return { key, kind: "firewall", item: f, parent, inactive, children: h.vlans.filter((v) => v.firewallId === f.id).sort(bySort).map((v) => vlanNode(v, key, inactive)) };
  };
  const out: Node[] = h.services.slice().sort(bySort).map((s) => {
    const inactive = off(s, "", `service ${s.name}`);
    const key = `service:${s.id}`;
    const children = h.firewalls.filter((f) => f.serviceId === s.id).sort(bySort).map((f) => fwNode(f, key, inactive));
    // Devices that name this service but match none of its VLANs.
    const loose = h.devices.filter((d) => d.serviceId === s.id && !(d.vlanId && vids.has(d.vlanId))).sort(bySort);
    if (loose.length) {
      const gk = `group:${s.id}:novlan`;
      children.push({ key: gk, kind: "group", label: "Devices without a VLAN", parent: key, inactive, children: loose.map((d) => devNode(d, gk)) });
    }
    return { key, kind: "service", item: s, parent: "root", inactive, children };
  });

  const un: Node[] = [];
  const fw0 = h.firewalls.filter((f) => !(f.serviceId && sids.has(f.serviceId))).sort(bySort);
  const vl0 = h.vlans.filter((v) => !(v.firewallId && fids.has(v.firewallId))).sort(bySort);
  const dv0 = h.devices.filter((d) => !(d.vlanId && vids.has(d.vlanId)) && !(d.serviceId && sids.has(d.serviceId))).sort(bySort);
  const g = "group:unassigned";
  un.push(...fw0.map((f) => fwNode(f, g, "")), ...vl0.map((v) => vlanNode(v, g, "")), ...dv0.map((d) => devNode(d, g)));
  if (un.length) out.push({ key: g, kind: "group", label: "Unassigned (no service)", parent: "root", inactive: "", children: un });
  return out;
}

const count = (n: Node, k: Kind): number => n.children.reduce((a, c) => a + (c.kind === k ? 1 : 0) + count(c, k), 0);

export function TreeView({ h, setH, refresh }: { h: Hierarchy; setH: (h: Hierarchy) => void; refresh: () => Promise<void> }) {
  const ui = useUi();
  const [pref, setPref] = useLocal<{ collapsed: string[]; showInactive: boolean }>("fpl.net.tree", { collapsed: [], showInactive: false });
  const [arrange, setArrange] = useState(false);
  const [drag, setDrag] = useState<{ key: string; parent: string; kind: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const tree = useMemo(() => build(h), [h]);
  const collapsed = new Set(pref.collapsed);
  const show = arrange || pref.showInactive;

  const allKeys = (ns: Node[]): string[] => ns.flatMap((n) => (n.children.length ? [n.key, ...allKeys(n.children)] : []));
  const toggle = (k: string) => setPref({ ...pref, collapsed: collapsed.has(k) ? pref.collapsed.filter((x) => x !== k) : [...pref.collapsed, k] });

  const activeDevices = h.devices.filter((d) => !inactiveReason(d, h)).length;

  const setEnabled = async (n: Node, enabled: boolean) => {
    const kind = n.kind as Kind;
    const t = TABLE[kind];
    const id = n.item!.id;
    setH({ ...h, [t]: (h[t] as Item[]).map((x) => (x.id === id ? { ...x, enabled } : x)) });
    try {
      await (api[t].update as (id: string, b: object) => Promise<unknown>)(id, { enabled });
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
      refresh();
    }
  };

  /** Move `key` to position `to` among its same-kind siblings. */
  const move = async (siblings: Node[], key: string, to: number) => {
    const same = siblings.filter((s) => s.kind === siblings.find((x) => x.key === key)!.kind);
    const from = same.findIndex((s) => s.key === key);
    if (from < 0 || to < 0 || to >= same.length || to === from) return;
    const order = same.slice();
    const [m] = order.splice(from, 1);
    order.splice(to, 0, m);
    const kind = m.kind as Kind;
    const t = TABLE[kind];
    const ids = order.map((s) => s.item!.id);
    const pos = new Map(ids.map((id, i) => [id, i]));
    setH({ ...h, [t]: (h[t] as Item[]).map((x) => (pos.has(x.id) ? { ...x, sort: pos.get(x.id)! } : x)) });
    try {
      await api[t].reorder(ids);
    } catch (e) {
      ui.toast(`Couldn’t reorder: ${errMsg(e)}`);
      refresh();
    }
  };

  const describe = (n: Node) => {
    const it = n.item;
    switch (n.kind) {
      case "service": {
        const s = it as Service;
        return (
          <>
            <b>{s.name || "(unnamed)"}</b>
            <span className="tag">{s.kind}</span>
            {s.contractor && <span className="muted">· {s.contractor}</span>}
            <span className="muted cnt">{count(n, "firewall")} FW · {count(n, "vlan")} VLAN · {count(n, "device")} devices</span>
          </>
        );
      }
      case "firewall": {
        const f = it as Firewall;
        return (
          <>
            <b>{f.name || "(unnamed)"}</b>
            {f.vendorModel && <span className="muted">{f.vendorModel}</span>}
            {f.mgmtIp && <span className="mono muted">{f.mgmtIp}</span>}
            <span className="muted cnt">{count(n, "vlan")} VLAN · {count(n, "device")} devices</span>
          </>
        );
      }
      case "vlan": {
        const v = it as Vlan;
        return (
          <>
            <b>VLAN {v.vlan || "?"}</b>
            <span>{v.name}</span>
            {v.subnet && <span className="mono muted">{v.subnet}</span>}
            {v.gateway && <span className="mono muted">gw {v.gateway}</span>}
            <span className="muted cnt">{n.children.length} devices</span>
          </>
        );
      }
      case "device": {
        const d = it as Device;
        return (
          <>
            <b>{d.name || "(unnamed)"}</b>
            {d.type && <span className="muted">{d.type}</span>}
            {d.ip && <span className="mono">{d.ip}</span>}
            {d.serial && <span className="mono muted">SN {d.serial}</span>}
          </>
        );
      }
      default:
        return <b className="muted">{n.label}</b>;
    }
  };

  const BADGE: Record<string, string> = { service: "SVC", firewall: "FW", vlan: "VLAN", device: "DEV", group: "" };

  const render = (ns: Node[], depth: number): React.ReactNode[] => {
    const vis = ns.filter((n) => show || !n.inactive || n.kind === "group");
    return vis.flatMap((n) => {
      const same = ns.filter((s) => s.kind === n.kind);
      const idx = same.findIndex((s) => s.key === n.key);
      const open = !collapsed.has(n.key);
      const movable = arrange && n.kind !== "group";
      const own = n.kind !== "group" && (n.item as { enabled?: boolean }).enabled !== false;
      const row = (
        <div
          key={n.key}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={n.children.length ? open : undefined}
          className={["tnode", `k-${n.kind}`, n.inactive && "off", over === n.key && "over"].filter(Boolean).join(" ")}
          style={{ paddingLeft: 8 + depth * 20 }}
          title={n.inactive ? `Inactive: ${n.inactive}` : undefined}
          draggable={movable}
          onDragStart={(e) => {
            setDrag({ key: n.key, parent: n.parent, kind: n.kind });
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            setDrag(null);
            setOver(null);
          }}
          onDragOver={(e) => {
            if (drag && drag.parent === n.parent && drag.kind === n.kind && drag.key !== n.key) {
              e.preventDefault();
              setOver(n.key);
            }
          }}
          onDragLeave={() => over === n.key && setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            if (drag && drag.parent === n.parent && drag.kind === n.kind) move(ns, drag.key, idx);
            setDrag(null);
            setOver(null);
          }}
        >
          {movable && <span className="grip" aria-hidden="true">⋮⋮</span>}
          <button type="button" className="caret" aria-label={open ? "Collapse" : "Expand"} disabled={!n.children.length} onClick={() => toggle(n.key)}>
            {n.children.length ? (open ? "▾" : "▸") : ""}
          </button>
          {BADGE[n.kind] && <span className={`badge b-${n.kind}`}>{BADGE[n.kind]}</span>}
          <span className="tdesc">{describe(n)}</span>
          {!arrange && n.kind !== "group" && (!own ? <span className="chip">inactive</span> : n.inactive && <span className="muted off-why">({n.inactive})</span>)}
          {movable && (
            <span className="tctl">
              <label className="en" title="Enabled">
                <input type="checkbox" checked={own} aria-label={`Enabled: ${n.kind}`} onChange={(e) => setEnabled(n, e.target.checked)} />
                {own ? "Active" : "Inactive"}
              </label>
              <button type="button" className="btn-ghost" aria-label="Move up" disabled={idx === 0} onClick={() => move(ns, n.key, idx - 1)}>↑</button>
              <button type="button" className="btn-ghost" aria-label="Move down" disabled={idx === same.length - 1} onClick={() => move(ns, n.key, idx + 1)}>↓</button>
            </span>
          )}
        </div>
      );
      return [row, ...(open ? render(n.children, depth + 1) : [])];
    });
  };

  const empty = !h.services.length && !h.firewalls.length && !h.vlans.length && !h.devices.length;
  return (
    <div className="treewrap">
      <div className="toolbar sub">
        <button type="button" onClick={() => setPref({ ...pref, collapsed: [] })}>Expand all</button>
        <button type="button" onClick={() => setPref({ ...pref, collapsed: allKeys(tree) })}>Collapse all</button>
        <label className="chk-l">
          <input type="checkbox" checked={pref.showInactive} onChange={(e) => setPref({ ...pref, showInactive: e.target.checked })} /> Show inactive
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          {activeDevices} of {h.devices.length} devices active (service → firewall → VLAN → device all enabled)
        </span>
        <span className="grow" />
        <button type="button" className={arrange ? "btn-primary" : undefined} aria-pressed={arrange} onClick={() => setArrange(!arrange)} title="Reorder services, firewalls, VLANs and devices within their parent, and switch each level active / inactive">
          {arrange ? "Done arranging" : "Arrange order & active…"}
        </button>
      </div>
      {arrange && (
        <div className="hint">
          Drag ⋮⋮ or use ↑ ↓ to change the rendering order within each parent; the order is used in every tab and in the IP schema. Untick a level to make it and everything under it inactive — a device renders only when its service, firewall, VLAN and itself are all active.
        </div>
      )}
      <div className="scroll">
        {empty ? (
          <div className="empty-state"><h3>Nothing to show yet</h3><p>Add services, firewalls, VLANs and devices in the other tabs.</p></div>
        ) : (
          <div className="tree" role="tree" aria-label="Network hierarchy">{render(tree, 0)}</div>
        )}
      </div>
    </div>
  );
}
