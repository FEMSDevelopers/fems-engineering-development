import {
  chainOf, elemKey, hopElements, protocolLabel, routeSides, serviceColor, setPortAt, treeRank,
  type Connection, type Device, type DeviceCategory, type Hierarchy, type NetElem, type PortRef, type ProtocolDef, type RouteSide,
} from "@fpl/core";
import { useMemo, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { Modal, Popover, useLocal, useUi } from "../ui";
import { numberedIds, numStyle, type NumColors } from "./numbering";

/** Distinct colours for VLANs on the detail sheets (by VLAN order). */
const VLAN_PALETTE = ["#1f6fc4", "#c46a1f", "#3d8b3d", "#8e44ad", "#b8417a", "#2f7f8a", "#8a6d2f", "#c0392b", "#16a085", "#5b4fc4"];
// Sheet ("paper") colours: fixed so a downloaded SVG looks the same anywhere.
const INK = "#1d2327";
const MUTED = "#5b6872";
const LINE = "#c3ccd2";
const FW_COLOR = "#c4513f";

const ROW = 50;
const PEER_W = 210;
const CENTER_W = 240;
const GAP = 210;
const MARGIN = 24;
const HEAD = 72;

interface Props {
  h: Hierarchy;
  /** Active devices (the same set the diagram draws). */
  devices: Device[];
  connections: Connection[];
  protocols: ProtocolDef[];
  cats: DeviceCategory[];
  /** Called after edits were written to the server (the caller reloads and saves sub-versions). */
  onApplied?: (note: string) => Promise<void>;
}
interface Pref {
  /** Selected element keys (null = default selection). */
  sel: string[] | null;
  /** Sheets shown (multi-select); empty = all selected. */
  view: string[];
  /** Per sheet: stages hidden between the main element and the end devices (SHOW_ITEMS keys, or "hop:<element key>"). */
  hidden?: Record<string, string[]>;
}
/** Stages that can be shown or hidden on each sheet, in route order ("hops" is replaced by one entry per element in between). */
const SHOW_ITEMS: [string, string][] = [["mainPort", "Main port"], ["mainVlan", "Main VLAN"], ["hops", "In between"], ["endVlan", "End VLAN"], ["endPort", "End port"], ["nums", "Connection numbers"]];

/** Editing callbacks handed to each sheet. */
interface Editor {
  on: boolean;
  setPort: (refs: PortRef[], value: string) => void;
  /** Change the end device of these routes (client or server of each connection). */
  setEnd: (routes: RouteSide[], deviceId: string) => void;
  /** Set the per-end VLAN of these routes at their end device ("end") or at the main element when it is an end ("main"). */
  setVlan: (routes: RouteSide[], which: "end" | "main", vlanId: string) => void;
  setDevice: (id: string, patch: Partial<Device>) => void;
  deviceOpts: [string, string][];
  vlanOpts: [string, string][];
  catOpts: [string, string][];
  svcOpts: [string, string][];
}

/** Network details: auto-generated port allocation sheets for firewalls and switches, from the connection paths. */
export function NetworkDetails({ h, devices, connections, protocols, cats, onApplied }: Props) {
  const ui = useUi();
  const [pref, setPref] = useLocal<Pref>("fpl.netdetail.v2", { sel: null, view: [] });
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Pending edits (written on Save, or when Edit is switched off).
  const [draft, setDraft] = useState<Map<string, Connection>>(new Map());
  const [devDraft, setDevDraft] = useState<Map<string, Partial<Device>>>(new Map());
  // Row numbers and their colours come from the diagram's saved summary arrangement.
  const [diagram] = useLocal<{ summary?: { order?: string[]; numColors?: NumColors } }>("fpl.diagram.v1", {});

  const origConn = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const effDevices = useMemo(() => devices.map((d) => (devDraft.has(d.id) ? { ...d, ...devDraft.get(d.id) } : d)), [devices, devDraft]);
  const effConns = useMemo(() => connections.map((c) => draft.get(c.id) ?? c), [connections, draft]);

  const dmap = useMemo(() => new Map(effDevices.map((d) => [d.id, d])), [effDevices]);
  const fmap = useMemo(() => new Map(h.firewalls.map((f) => [f.id, f])), [h.firewalls]);
  const vmap = useMemo(() => new Map(h.vlans.map((v) => [v.id, v])), [h.vlans]);
  const cmap = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const pmap = useMemo(() => new Map(protocols.map((p) => [p.id, p])), [protocols]);
  const full = useMemo(() => ({ ...h, devices: effDevices }), [h, effDevices]);
  const rank = useMemo(() => treeRank(full), [full]);

  const conns = useMemo(
    () => effConns.filter((c) => c.fromId && c.toId && c.fromId !== c.toId && dmap.has(c.fromId) && dmap.has(c.toId) && c.protocolId && pmap.has(c.protocolId)),
    [effConns, dmap, pmap],
  );
  const numbered = useMemo(() => numberedIds(diagram.summary?.order ?? [], conns), [diagram.summary?.order, conns]);
  const numOf = useMemo(() => new Map(numbered.map((id, i) => [id, i + 1])), [numbered]);
  const numColors = diagram.summary?.numColors ?? {};
  const vlanColor = useMemo(() => {
    const order = h.vlans.slice().sort(rank.vlans);
    return new Map(order.map((v, i) => [v.id, VLAN_PALETTE[i % VLAN_PALETTE.length]]));
  }, [h.vlans, rank]);

  // ---- candidates: firewalls, every device, custom trajectories ----
  const hops = useMemo(() => hopElements(conns), [conns]);
  const hopKeys = useMemo(() => new Set(hops.map(elemKey)), [hops]);
  const netCat = cats.find((c) => /network/i.test(c.name));
  const candidates = useMemo(() => {
    const fw: NetElem[] = h.firewalls.slice().sort(rank.firewalls).map((f) => ({ kind: "firewall", id: f.id }));
    const dv: NetElem[] = effDevices.slice().sort(rank.devices).map((d) => ({ kind: "device", id: d.id }));
    return [...fw, ...dv, ...hops.filter((e) => e.kind === "custom")];
  }, [h.firewalls, effDevices, hops, rank]);
  const defaultSel = useMemo(
    () => candidates.filter((e) => e.kind === "firewall" || hopKeys.has(elemKey(e)) || (e.kind === "device" && netCat && dmap.get(e.id)?.categoryId === netCat.id)).map(elemKey),
    [candidates, hopKeys, netCat, dmap],
  );
  const known = new Set(candidates.map(elemKey));
  const sel = (pref.sel ?? defaultSel).filter((k) => known.has(k));
  const selElems = candidates.filter((e) => sel.includes(elemKey(e)));
  const view = pref.view.filter((k) => sel.includes(k));
  const sheets = view.length ? selElems.filter((e) => view.includes(elemKey(e))) : selElems;
  const toggleView = (k: string) => setPref({ ...pref, view: view.includes(k) ? view.filter((x) => x !== k) : [...view, k] });

  // ---- naming / colours ----
  const nameOf = (e: NetElem) => (e.kind === "custom" ? e.label ?? "custom trajectory" : e.kind === "firewall" ? fmap.get(e.id)?.name || "(firewall)" : dmap.get(e.id)?.name || "(device)");
  const colorOf = (e: NetElem) => {
    if (e.kind === "firewall") return FW_COLOR;
    if (e.kind === "custom") return MUTED;
    const d = dmap.get(e.id);
    return d ? serviceColor(chainOf(d, full).service, h.services) : MUTED;
  };
  const infoOf = (e: NetElem): string[] => {
    if (e.kind === "custom") return ["Custom network trajectory"];
    if (e.kind === "firewall") {
      const f = fmap.get(e.id);
      const svc = f?.serviceId ? h.services.find((s) => s.id === f.serviceId) : undefined;
      return [["Firewall", f?.vendorModel].filter(Boolean).join(" · "), [f?.mgmtIp, svc?.name].filter(Boolean).join(" · ")];
    }
    const d = dmap.get(e.id);
    if (!d) return [];
    const v = d.vlanId ? vmap.get(d.vlanId) : undefined;
    const svc = chainOf(d, full).service;
    return [[d.type, d.model].filter(Boolean).join(" · "), [d.ip, v ? `VLAN ${v.vlan}` : "", svc?.name].filter(Boolean).join(" · ")];
  };
  const vlanText = (ids: string[]) => ids.map((id) => vmap.get(id)).filter(Boolean).map((v) => v!.vlan).join(", ");

  // ---- editing ----
  const changedConns = [...draft.entries()].filter(([id, c]) => JSON.stringify(c) !== JSON.stringify(origConn.get(id)));
  const changedDevs = [...devDraft.entries()].filter(([id, p]) => {
    const d = devices.find((x) => x.id === id);
    return d && Object.entries(p).some(([k, v]) => (d as unknown as Record<string, unknown>)[k] !== v);
  });
  const changes = changedConns.length + changedDevs.length;
  const editConn = (id: string, f: (c: Connection) => Connection) =>
    setDraft((m) => {
      const base = m.get(id) ?? origConn.get(id);
      if (!base) return m;
      const n = new Map(m);
      n.set(id, f(base));
      return n;
    });
  const editor: Editor = {
    on: editing,
    setPort: (refs, value) => refs.forEach((r) => editConn(r.connId, (c) => setPortAt(c, r, value))),
    setEnd: (routes, deviceId) => routes.forEach((r) => editConn(r.connId, (c) => (r.endAt === "client" ? { ...c, fromId: deviceId } : { ...c, toId: deviceId }))),
    setVlan: (routes, which, vlanId) =>
      routes.forEach((rt) => {
        const at = which === "end" ? rt.endAt : rt.mainAt;
        if (at === "hop") return;
        const r = { at };
        editConn(rt.connId, (c) => {
          // Per-end VLAN: switching it on starts both ends from the devices' own IPs.
          const f = c.fromId ? dmap.get(c.fromId) : undefined;
          const t = c.toId ? dmap.get(c.toId) : undefined;
          const base = c.endNet ? c : { ...c, endNet: true, clientIp: c.clientIp || f?.ip || "", serverIp: c.serverIp || t?.ip || "", clientVlanId: c.clientVlanId ?? f?.vlanId ?? null, serverVlanId: c.serverVlanId ?? t?.vlanId ?? null };
          return r.at === "client" ? { ...base, clientVlanId: vlanId || null } : { ...base, serverVlanId: vlanId || null };
        });
      }),
    setDevice: (id, patch) => setDevDraft((m) => new Map(m).set(id, { ...m.get(id), ...patch })),
    deviceOpts: effDevices.slice().sort(rank.devices).map((d) => [d.id, d.name || d.ip || "(unnamed)"]),
    vlanOpts: h.vlans.slice().sort(rank.vlans).map((v) => [v.id, `VLAN ${v.vlan}${v.name ? ` ${v.name}` : ""}`]),
    catOpts: [["", "— none —"], ...cats.map((c) => [c.id, c.name] as [string, string])],
    svcOpts: [["", "— any —"], ...h.services.slice().sort(rank.services).map((s) => [s.id, s.name || "(unnamed)"] as [string, string])],
  };

  /** Write pending edits, then let the caller reload and record sub-versions. */
  const apply = async () => {
    if (!changes) return;
    setBusy(true);
    try {
      for (const [id, c] of changedConns)
        await api.connections.update(id, {
          fromId: c.fromId, toId: c.toId, clientPort: c.clientPort ?? "", serverPort: c.serverPort ?? "", path: c.path ?? [],
          endNet: !!c.endNet, clientIp: c.clientIp ?? "", serverIp: c.serverIp ?? "", clientVlanId: c.clientVlanId ?? null, serverVlanId: c.serverVlanId ?? null,
        });
      for (const [id, p] of changedDevs) await api.devices.update(id, p);
      const note = `Network details: ${changedConns.length} connection(s), ${changedDevs.length} device(s) edited`;
      setDraft(new Map());
      setDevDraft(new Map());
      await onApplied?.(note);
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const toggleEdit = async () => {
    // Switching Edit off with pending changes saves them (and records sub-versions).
    if (editing && changes) await apply();
    setEditing(!editing);
  };
  const discard = () => {
    setDraft(new Map());
    setDevDraft(new Map());
  };

  const columns = useMemo(() => {
    const devs = (pred: (d: Device) => boolean) => candidates.filter((e) => e.kind === "device" && pred(dmap.get(e.id)!));
    return [
      { key: "fw", title: "Firewalls", items: candidates.filter((e) => e.kind === "firewall"), color: FW_COLOR },
      ...cats.map((c) => ({ key: c.id, title: c.name, items: devs((d) => d.categoryId === c.id), color: c.color })),
      { key: "none", title: "No category", items: devs((d) => !d.categoryId || !cmap.has(d.categoryId)), color: MUTED },
      { key: "custom", title: "Custom trajectories", items: candidates.filter((e) => e.kind === "custom"), color: MUTED },
    ].filter((c) => c.items.length);
  }, [candidates, cats, cmap, dmap]);

  return (
    <div className="netdetail">
      <div className="nd-bar">
        <div className="nd-tabs" role="group" aria-label="Sheets to show (select several)">
          <button type="button" aria-pressed={!view.length} onClick={() => setPref({ ...pref, view: [] })}>All ({selElems.length})</button>
          {selElems.map((e) => {
            const n = new Set(routeSides(e, conns, effDevices).map((r) => `${r.dir}|${r.port}`)).size;
            const k = elemKey(e);
            return (
              <button key={k} type="button" aria-pressed={view.includes(k)} onClick={() => toggleView(k)} title={`${n} port${n === 1 ? "" : "s"} in use · click to add / remove this sheet`}>
                <i style={{ background: colorOf(e) }} />
                {nameOf(e)}
                <span className="cnt">{n}</span>
              </button>
            );
          })}
        </div>
        <span className="grow" />
        <button type="button" onClick={() => setPicking(true)} title="Choose which firewalls / switches / devices get a detail sheet">Devices…</button>
        {editing && changes > 0 && <button type="button" className="btn-ghost" onClick={discard} title="Drop the pending edits">Discard</button>}
        {editing && (
          <button type="button" className="btn-primary" disabled={!changes || busy} onClick={apply} title="Write the edits to the connection list / devices and save sub-versions">
            Save{changes ? ` (${changes})` : ""}
          </button>
        )}
        <button type="button" aria-pressed={editing} className={editing ? "on" : undefined} disabled={busy} onClick={toggleEdit} title="Edit ports, peers, VLANs, categories and services from the port tables">
          {editing ? "Done editing" : "Edit"}
        </button>
      </div>
      {editing && (
        <div className="nd-editbar">
          Editing: change Port, Main VLAN, End VLAN, End device, End port, Peer type or Service in the tables below — the drawings update as you type. <b>Save</b> (or <b>Done editing</b>) writes them to the connection list and devices and records a sub-version of both the connection list and the network.
        </div>
      )}
      <div className="nd-body">
        {!conns.some((c) => (c.path ?? []).length) && (
          <div className="nd-hint">
            Sheets are generated from the connection paths: each port of the main element is followed through its VLAN and any hops to the end devices. Open a connection (✎) to add hops and ports.
          </div>
        )}
        {!sheets.length ? (
          <div className="empty-state"><h3>No devices selected</h3><p>Use Devices… to pick the firewalls and switches to draw.</p></div>
        ) : (
          sheets.map((e) => (
            <Sheet
              key={elemKey(e)}
              elem={e}
              routes={routeSides(e, conns, effDevices)}
              hidden={pref.hidden?.[elemKey(e)] ?? []}
              onHidden={(list) => setPref({ ...pref, hidden: { ...(pref.hidden ?? {}), [elemKey(e)]: list } })}
              nameOf={nameOf}
              colorOf={colorOf}
              infoOf={infoOf}
              vlanColor={vlanColor}
              vlanText={vlanText}
              vmap={vmap}
              conns={conns}
              pmap={pmap}
              numOf={numOf}
              numColors={numColors}
              editor={editor}
              dmap={dmap}
              catOf={(x) => (x.kind === "device" ? cmap.get(dmap.get(x.id)?.categoryId ?? "")?.name ?? "" : x.kind === "firewall" ? "Firewall" : "Custom")}
              svcOf={(x) => {
                if (x.kind === "device") {
                  const d = dmap.get(x.id);
                  return d ? chainOf(d, full).service?.name ?? "" : "";
                }
                if (x.kind === "firewall") return h.services.find((s) => s.id === fmap.get(x.id)?.serviceId)?.name ?? "";
                return "";
              }}
            />
          ))
        )}
      </div>
      {picking && (
        <Modal onClose={() => setPicking(false)} label="Devices to detail">
          <div className="mh"><h3>Devices to detail</h3><span className="grow" /><span className="muted">{sel.length} selected</span></div>
          <div className="mb">
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              Each selected firewall, switch or device gets a detail sheet; everything it is cabled to is drawn around it as external. Default: all firewalls, devices used as hops and devices in the Network category.
            </p>
            <div className="nd-pick">
              {columns.map((col) => {
                const keys = col.items.map(elemKey);
                const all = keys.every((k) => sel.includes(k));
                return (
                  <div key={col.key} className="col">
                    <div className="ch">
                      <i style={{ background: col.color }} />
                      <b>{col.title}</b>
                      <button type="button" className="btn-ghost" onClick={() => setPref({ ...pref, sel: all ? sel.filter((k) => !keys.includes(k)) : [...new Set([...sel, ...keys])] })}>
                        {all ? "None" : "All"}
                      </button>
                    </div>
                    {col.items.map((e) => {
                      const k = elemKey(e);
                      const used = hopKeys.has(k);
                      return (
                        <label key={k} className="ctl" title={used ? "Used as a hop in at least one connection path" : undefined}>
                          <input type="checkbox" checked={sel.includes(k)} onChange={(ev) => setPref({ ...pref, sel: ev.target.checked ? [...sel, k] : sel.filter((x) => x !== k) })} />
                          {nameOf(e)}
                          {used && <span className="hopdot" aria-label="used as hop">●</span>}
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mf">
            <button type="button" onClick={() => setPref({ ...pref, sel: null })}>Default selection</button>
            <button type="button" className="btn-primary" onClick={() => setPicking(false)}>Done</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function download(name: string, type: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Edits a text cell on blur / Enter. */
function EditText({ value, label, onCommit }: { value: string; label: string; onCommit: (v: string) => void }) {
  return (
    <input
      type="text"
      className="mono nd-in"
      aria-label={label}
      defaultValue={value}
      key={value}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      onBlur={(e) => e.target.value.trim() !== value && onCommit(e.target.value.trim())}
    />
  );
}

const HOP_STEP = 150;
const HOP_W = 124;
const NODE_W = 70;

/** A row on one side of a sheet: one end device (and end port), reached through one route group. */
interface DevRow {
  key: string;
  routes: RouteSide[];
  y: number;
}
interface SegGroup {
  key: string;
  endVlan: string | null;
  hops: NetElem[];
  rows: DevRow[];
  y: number;
}
interface MainGroup {
  key: string;
  mainVlan: string | null;
  segs: SegGroup[];
  y: number;
}
interface PortGroup {
  port: string;
  mains: MainGroup[];
  y: number;
}

/**
 * One drawing sheet. Each side (left: towards clients, right: towards servers) is drawn as
 * main port → main VLAN → one line per end VLAN (through any hops shown) → a branch to each end device.
 */
function Sheet({
  elem, routes, hidden, onHidden, nameOf, colorOf, infoOf, vlanColor, vlanText, vmap, conns, pmap, numOf, numColors, catOf, svcOf, editor, dmap,
}: {
  elem: NetElem;
  routes: RouteSide[];
  hidden: string[];
  onHidden: (list: string[]) => void;
  nameOf: (e: NetElem) => string;
  colorOf: (e: NetElem) => string;
  infoOf: (e: NetElem) => string[];
  vlanColor: Map<string, string>;
  vlanText: (ids: string[]) => string;
  vmap: Map<string, { vlan: string; name: string; subnet: string }>;
  conns: Connection[];
  pmap: Map<string, ProtocolDef>;
  numOf: Map<string, number>;
  numColors: NumColors;
  catOf: (e: NetElem) => string;
  svcOf: (e: NetElem) => string;
  editor: Editor;
  dmap: Map<string, Device>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const cmap = new Map(conns.map((c) => [c.id, c]));
  const on = (k: string) => !hidden.includes(k);
  const P = on("mainPort");
  const MV = on("mainVlan");
  const EV = on("endVlan");
  const EP = on("endPort");
  const NUMS = on("nums");
  const hopShown = (e: NetElem) => on("hops") && on(`hop:${elemKey(e)}`);
  const dev = (id: string): NetElem => ({ kind: "device", id });
  const vName = (id: string | null) => (id && vmap.get(id) ? `VLAN ${vmap.get(id)!.vlan}` : "no VLAN");
  const vCol = (id: string | null) => (id ? vlanColor.get(id) ?? MUTED : MUTED);
  const vOrder = (id: string | null) => (id && vmap.get(id) ? Number(vmap.get(id)!.vlan) || 0 : 1e9);
  const natural = (a: string, b: string) => (a ? (b ? a.localeCompare(b, undefined, { numeric: true }) : -1) : b ? 1 : 0);

  // ---- group the routes of one side: port → main VLAN → (end VLAN + shown hops) → end device ----
  const build = (dir: RouteSide["dir"]) => {
    const list = routes.filter((r) => r.dir === dir);
    const ports = new Map<string, Map<string, Map<string, Map<string, RouteSide[]>>>>();
    for (const r of list) {
      const pk = P ? r.port : "";
      const mk = MV ? r.mainVlan ?? "" : "*";
      const sk = `${EV ? r.endVlan ?? "" : "*"}|${r.hops.filter(hopShown).map(elemKey).join(">")}`;
      const dk = `${r.endId}${EP ? `|${r.endPort}` : ""}`;
      const pm = ports.get(pk) ?? new Map();
      const mm = pm.get(mk) ?? new Map();
      const sm = mm.get(sk) ?? new Map();
      sm.set(dk, [...(sm.get(dk) ?? []), r]);
      mm.set(sk, sm);
      pm.set(mk, mm);
      ports.set(pk, pm);
    }
    const groups: PortGroup[] = [...ports.entries()]
      .sort((a, b) => natural(a[0], b[0]))
      .map(([port, mains]) => ({
        port,
        y: 0,
        mains: [...mains.entries()]
          .map(([key, segs]) => {
            const first = [...segs.values()][0].values().next().value as RouteSide[];
            return {
              key,
              y: 0,
              mainVlan: MV ? first[0].mainVlan : null,
              segs: [...segs.entries()]
                .map(([skey, devs]) => {
                  const r0 = (devs.values().next().value as RouteSide[])[0];
                  return {
                    key: skey,
                    y: 0,
                    endVlan: EV ? r0.endVlan : null,
                    hops: r0.hops.filter(hopShown),
                    rows: [...devs.entries()]
                      .map(([dk, rs]) => ({ key: dk, routes: rs, y: 0 }))
                      .sort((a, b) => nameOf(dev(a.routes[0].endId)).localeCompare(nameOf(dev(b.routes[0].endId))) || natural(a.routes[0].endPort, b.routes[0].endPort)),
                  } as SegGroup;
                })
                .sort((a, b) => vOrder(a.endVlan) - vOrder(b.endVlan) || a.key.localeCompare(b.key)),
            } as MainGroup;
          })
          .sort((a, b) => vOrder(a.mainVlan) - vOrder(b.mainVlan)),
      }));
    const rows = groups.flatMap((g) => g.mains.flatMap((m) => m.segs.flatMap((sg) => sg.rows)));
    const slots = Math.max(0, ...groups.flatMap((g) => g.mains.flatMap((m) => m.segs.map((sg) => sg.hops.length))));
    return { groups, rows, slots };
  };
  const L = build("toClient");
  const R = build("toServer");

  // ---- horizontal layout (offsets from the main element's edge) ----
  const layoutOf = (slots: number, has: boolean) => {
    const oPort = 40;
    const oMain = MV ? oPort + 26 + NODE_W / 2 : oPort;
    const oMainOut = MV ? oMain + NODE_W / 2 + 26 : oPort;
    const hopsStart = oMainOut + 14;
    const hopsEnd = hopsStart + slots * HOP_STEP;
    const oEnd = EV ? hopsEnd + 16 + NODE_W / 2 : hopsEnd;
    const oBus = EV ? oEnd + NODE_W / 2 + 26 : hopsEnd + 16;
    const oDev = oBus + 34;
    return { oPort, oMain, oMainOut, hopsStart, oEnd, oBus, oDev, width: has ? oDev + PEER_W : 230 };
  };
  const LL = layoutOf(L.slots, L.rows.length > 0);
  const RL = layoutOf(R.slots, R.rows.length > 0);
  const n = Math.max(L.rows.length, R.rows.length, 1);
  const W = MARGIN * 2 + LL.width + CENTER_W + RL.width;
  const cx = MARGIN + LL.width;
  const top = HEAD + 20;
  const centerH = Math.max(110, n * ROW + 30);

  // ---- vertical layout: rows evenly, groups at the middle of their children ----
  const place = (side: { groups: PortGroup[]; rows: DevRow[] }) => {
    const count = side.rows.length;
    side.rows.forEach((r, i) => (r.y = top + 15 + (centerH - 30 - count * ROW) / 2 + i * ROW + ROW / 2));
    const mid = (ys: number[]) => (Math.min(...ys) + Math.max(...ys)) / 2;
    for (const g of side.groups) {
      for (const m of g.mains) {
        for (const sg of m.segs) sg.y = mid(sg.rows.map((r) => r.y));
        m.y = mid(m.segs.map((sg) => sg.y));
      }
      g.y = mid(g.mains.map((m) => m.y));
    }
  };
  place(L);
  place(R);

  const usedVlans = [...new Set(routes.flatMap((r) => [r.mainVlan, r.endVlan]).filter((x): x is string => !!x && vmap.has(x)))].sort((a, b) => vOrder(a) - vOrder(b));
  const legendY = top + centerH + 30;
  const legendText = (id: string) => {
    const v = vmap.get(id)!;
    return `VLAN ${v.vlan}${v.name ? ` ${v.name}` : ""} · ${v.subnet}`;
  };
  const legendMax = W - MARGIN * 2 - 280;
  let lx = MARGIN;
  let ly = legendY + 16;
  const legend = usedVlans.map((id) => {
    const w = 34 + legendText(id).length * 5.8 + 18;
    if (lx > MARGIN && lx + w > MARGIN + legendMax) {
      lx = MARGIN;
      ly += 16;
    }
    const at = { id, x: lx, y: ly };
    lx += w;
    return at;
  });
  const H = Math.max(legendY + 70, ly + 30);
  const color = colorOf(elem);
  const stampDate = new Date().toISOString().slice(0, 10);

  // ---- drawing helpers ----
  const numSquares = (ids: string[], x: number, y: number, anchorRight: boolean) => {
    if (!NUMS) return null;
    const list = ids.map((id) => ({ id, n: numOf.get(id) })).filter((q): q is { id: string; n: number } => !!q.n).sort((a, b) => a.n - b.n);
    let x0 = anchorRight ? x - list.reduce((a, q) => a + String(q.n).length * 7 + 9, 0) : x;
    return list.map((q) => {
      const c = cmap.get(q.id)!;
      const st = numStyle(numColors[q.id], pmap.get(c.protocolId ?? "")?.style.color ?? MUTED);
      const w = String(q.n).length * 7 + 7;
      const el = (
        <g key={q.id}>
          <rect x={x0} y={y - 7} width={w} height={14} rx={2} fill={st.bg} />
          <text x={x0 + w / 2} y={y + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fontFamily="monospace" fill={st.fg}>{q.n}</text>
          <title>{`Row ${q.n}: ${protocolLabel(pmap.get(c.protocolId ?? ""))}`}</title>
        </g>
      );
      x0 += w + 2;
      return el;
    });
  };
  const portBox = (x: number, y: number, label: string, col: string, align: "start" | "end") => {
    const w = Math.max(30, (label || "?").length * 6.4 + 10);
    const bx = align === "start" ? x : x - w;
    return (
      <g>
        <rect x={bx} y={y - 8} width={w} height={16} rx={3} fill="#fff" stroke={col} strokeWidth={1.2} />
        <text x={bx + w / 2} y={y + 3.5} textAnchor="middle" fontSize={10} fontFamily="monospace" fontWeight={600} fill={label ? INK : "#c0392b"}>{label || "?"}</text>
        {!label && <title>Port not specified in the connection path</title>}
      </g>
    );
  };
  const vlanNode = (x: number, y: number, id: string | null, what: string) => {
    const v = id ? vmap.get(id) : undefined;
    return (
      <g>
        <rect x={x - NODE_W / 2} y={y - 10} width={NODE_W} height={20} rx={10} fill={vCol(id)} />
        <text x={x} y={y + 4} textAnchor="middle" fontSize={10} fontWeight={700} fontFamily="monospace" fill="#fff">{vName(id)}</text>
        <title>{`${what}: ${v ? `VLAN ${v.vlan}${v.name ? ` — ${v.name}` : ""} (${v.subnet})` : "no VLAN"}`}</title>
      </g>
    );
  };
  const hopBox = (x: number, y: number, e: NetElem) => {
    const c = colorOf(e);
    const name = nameOf(e);
    return (
      <g key={elemKey(e) + x}>
        <rect x={x - HOP_W / 2} y={y - 11} width={HOP_W} height={22} rx={e.kind === "firewall" ? 3 : 11} fill="#fff" stroke={c} strokeWidth={1.3} strokeDasharray={e.kind === "custom" ? "5 3" : undefined} />
        <rect x={x - HOP_W / 2} y={y - 11} width={HOP_W} height={22} rx={e.kind === "firewall" ? 3 : 11} fill={c} fillOpacity={0.12} />
        <text x={x} y={y + 4} textAnchor="middle" fontSize={10} fontWeight={600} fill={INK}>{name.length > 18 ? name.slice(0, 17) + "…" : name}</text>
        <title>{`${e.kind === "firewall" ? "Firewall" : e.kind === "custom" ? "Custom trajectory" : "Device"}: ${name}`}</title>
      </g>
    );
  };
  const deviceBox = (row: DevRow, side: "left" | "right", xEdge: number) => {
    const r0 = row.routes[0];
    const e = dev(r0.endId);
    const info = infoOf(e);
    const pc = colorOf(e);
    const endPort = EP ? r0.endPort : "";
    const pw = EP ? Math.max(30, (endPort || "?").length * 6.4 + 10) : 0;
    const peerX = side === "left" ? xEdge - PEER_W : xEdge;
    const t = info[1] || info[0] || "";
    const room = Math.floor((PEER_W - 24 - pw) / 5.2);
    const sub = t.length > room ? t.slice(0, Math.max(4, room - 1)) + "…" : t;
    const tx = side === "left" ? peerX + 10 : peerX + PEER_W - 10;
    const anchor = side === "left" ? "start" : "end";
    const y = row.y;
    const ids = [...new Set(row.routes.map((r) => r.connId))];
    return (
      <g>
        <rect x={peerX} y={y - ROW / 2 + 4} width={PEER_W} height={ROW - 8} rx={6} fill="#fff" stroke={pc} strokeWidth={1.3} />
        <rect x={peerX} y={y - ROW / 2 + 4} width={PEER_W} height={ROW - 8} rx={6} fill={pc} fillOpacity={0.1} />
        <rect x={side === "left" ? peerX : peerX + PEER_W - 4} y={y - ROW / 2 + 4} width={4} height={ROW - 8} fill={pc} />
        <text x={tx} textAnchor={anchor} y={y - 5} fontSize={12} fontWeight={700} fill={INK}>{nameOf(e)}</text>
        <text x={tx} textAnchor={anchor} y={y + 9} fontSize={9.5} fill={MUTED}>{sub}</text>
        {side === "left" ? numSquares(ids, peerX + PEER_W - 4 - pw - 6, y - 9, true) : numSquares(ids, peerX + 4 + pw + 6, y - 9, false)}
        {EP && portBox(side === "left" ? peerX + PEER_W - 4 : peerX + 4, y, endPort, vCol(r0.endVlan), side === "left" ? "end" : "start")}
      </g>
    );
  };
  const line = (x1: number, y1: number, x2: number, y2: number, col: string, w = 2, dash?: string) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={w} strokeLinecap="round" strokeDasharray={dash} />
  );

  const drawSide = (side: { groups: PortGroup[]; rows: DevRow[] }, lay: ReturnType<typeof layoutOf>, s: "left" | "right") => {
    const dir = s === "left" ? -1 : 1;
    const edge = s === "left" ? cx : cx + CENTER_W;
    const X = (o: number) => edge + dir * o;
    return side.groups.map((g, gi) => {
      const pCol = g.mains.length === 1 ? vCol(g.mains[0].mainVlan ?? g.mains[0].segs[0].endVlan) : MUTED;
      const mainYs = g.mains.map((m) => m.y);
      return (
        <g key={gi}>
          {/* port → (split per main VLAN) */}
          {line(edge, g.y, X(lay.oPort), g.y, pCol, 3)}
          {g.mains.length > 1 && line(X(lay.oPort), Math.min(g.y, ...mainYs), X(lay.oPort), Math.max(g.y, ...mainYs), MUTED, 3)}
          {g.mains.map((m, mi) => {
            const mCol = vCol(m.mainVlan ?? (m.segs.length === 1 ? m.segs[0].endVlan : null));
            const segYs = m.segs.map((sg) => sg.y);
            return (
              <g key={mi}>
                {MV ? (
                  <>
                    {line(X(lay.oPort), m.y, X(lay.oMain - NODE_W / 2), m.y, mCol, 3)}
                    {line(X(lay.oMain + NODE_W / 2), m.y, X(lay.oMainOut), m.y, mCol, 3)}
                  </>
                ) : null}
                {m.segs.length > 1 && line(X(lay.oMainOut), Math.min(m.y, ...segYs), X(lay.oMainOut), Math.max(m.y, ...segYs), mCol, 3)}
                {m.segs.map((sg, si) => {
                  const eCol = vCol(sg.endVlan ?? m.mainVlan);
                  const devYs = sg.rows.map((r) => r.y);
                  // Same VLAN at both ends with nothing in between: one VLAN node is enough.
                  const endNode = EV && !(MV && !sg.hops.length && sg.endVlan === m.mainVlan);
                  const segEnd = endNode ? X(lay.oEnd - NODE_W / 2) : X(lay.oBus);
                  return (
                    <g key={si}>
                      {/* one consolidated line per end VLAN (and hops shown) */}
                      {line(X(lay.oMainOut), sg.y, segEnd, sg.y, mCol, 2.6)}
                      {sg.hops.map((hp, k) => hopBox(X(lay.hopsStart + k * HOP_STEP + HOP_STEP / 2), sg.y, hp))}
                      {endNode && line(X(lay.oEnd + NODE_W / 2), sg.y, X(lay.oBus), sg.y, eCol, 2.6)}
                      {endNode && vlanNode(X(lay.oEnd), sg.y, sg.endVlan, "End VLAN")}
                      {/* branch to each end device */}
                      {sg.rows.length > 1 && line(X(lay.oBus), Math.min(sg.y, ...devYs), X(lay.oBus), Math.max(sg.y, ...devYs), eCol, 2.4)}
                      {sg.rows.map((r, ri) => (
                        <g key={ri}>
                          {line(X(lay.oBus), r.y, X(lay.oDev), r.y, eCol, 1.8)}
                          {sg.rows.length > 1 && <circle cx={X(lay.oBus)} cy={r.y} r={2.8} fill={eCol} />}
                          {deviceBox(r, s, X(lay.oDev))}
                        </g>
                      ))}
                    </g>
                  );
                })}
                {MV && vlanNode(X(lay.oMain), m.y, m.mainVlan, "Main VLAN")}
              </g>
            );
          })}
          {P && portBox(edge + (s === "left" ? 4 : -4), g.y, g.port, pCol, s === "left" ? "start" : "end")}
        </g>
      );
    });
  };

  // ---- port table: one row per (direction, port, main VLAN, route, end device, end port), independent of what is drawn ----
  const tableRows = (() => {
    const m = new Map<string, RouteSide[]>();
    for (const r of routes) {
      const k = [r.dir, r.port, r.mainVlan, r.endVlan, r.hops.map(elemKey).join(">"), r.endId, r.endPort].join("|");
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.values()].sort(
      (a, b) => (a[0].dir === b[0].dir ? 0 : a[0].dir === "toClient" ? -1 : 1) || natural(a[0].port, b[0].port) || vOrder(a[0].mainVlan) - vOrder(b[0].mainVlan) || vOrder(a[0].endVlan) - vOrder(b[0].endVlan) || nameOf(dev(a[0].endId)).localeCompare(nameOf(dev(b[0].endId))),
    );
  })();
  const issuesOf = (rs: RouteSide[]) => [!rs[0].port && "Main port not specified", !rs[0].endPort && "End port not specified"].filter(Boolean) as string[];
  const warnCount = tableRows.reduce((a, rs) => a + issuesOf(rs).length, 0);
  const portCount = new Set(routes.map((r) => `${r.dir}|${r.port}`)).size;
  const centerInfo = infoOf(elem);
  const title = nameOf(elem);

  const exportSvg = () => {
    const el = svgRef.current;
    if (!el) return;
    download(`network-detail_${safe(title)}.svg`, "image/svg+xml", `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(el)}`);
  };
  const exportCsv = () => {
    const head = ["Device", "Port", "Direction", "Main VLAN", "Via", "End VLAN", "End device", "End port", "Peer type", "Service", "Connections", "Issues"];
    const lines = [
      head,
      ...tableRows.map((rs) => {
        const r = rs[0];
        const e = dev(r.endId);
        return [title, r.port || "(not specified)", r.dir === "toClient" ? "To clients" : "To servers", vlanText(r.mainVlan ? [r.mainVlan] : []), r.hops.map(nameOf).join(" › "), vlanText(r.endVlan ? [r.endVlan] : []), nameOf(e), r.endPort, catOf(e), svcOf(e), rs.map((x) => numOf.get(x.connId)).filter(Boolean).join(", "), issuesOf(rs).join("; ")];
      }),
    ];
    download(`network-detail_${safe(title)}.csv`, "text/csv;charset=utf-8", "﻿" + lines.map((l) => l.map((x) => csvCell(String(x))).join(",")).join("\r\n"));
  };
  const sel = (label: string, value: string, opts: [string, string][], onChange: (v: string) => void) => (
    <select className="nd-in" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!opts.some(([v]) => v === value) && <option value={value}>{value ? "?" : "—"}</option>}
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  // Elements in between that appear on this sheet (each can be hidden on its own).
  const between = (() => {
    const m = new Map<string, NetElem>();
    routes.forEach((r) => r.hops.forEach((e) => m.set(elemKey(e), e)));
    return [...m.values()];
  })();
  const toggleShow = (k: string) => onHidden(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k]);
  const shownCount = SHOW_ITEMS.filter(([k]) => on(k)).length;

  return (
    <section className="nd-sheet" aria-label={`Network detail of ${title}`}>
      <div className="nd-sh">
        <h3><i style={{ background: color }} />{title}</h3>
        <span className="muted">{portCount} port{portCount === 1 ? "" : "s"} · {tableRows.length} route{tableRows.length === 1 ? "" : "s"}{warnCount ? "" : " · no issues"}</span>
        {warnCount > 0 && <span className="chip err">{warnCount} issue{warnCount === 1 ? "" : "s"}</span>}
        <span className="grow" />
        <Popover label={`What to show on ${title}`} align="right" button={<>Show ({shownCount}/{SHOW_ITEMS.length})…</>}>
          {() => (
            <div className="nd-show">
              <p className="muted">Shown between {title} and the end devices:</p>
              {SHOW_ITEMS.map(([k, l]) => (
                <div key={k}>
                  <label className="ctl"><input type="checkbox" checked={on(k)} onChange={() => toggleShow(k)} /> {l}</label>
                  {k === "hops" && on("hops") && between.length > 0 && (
                    <div className="sub">
                      {between.map((e) => (
                        <label key={elemKey(e)} className="ctl">
                          <input type="checkbox" checked={on(`hop:${elemKey(e)}`)} onChange={() => toggleShow(`hop:${elemKey(e)}`)} />
                          <i style={{ background: colorOf(e) }} /> {nameOf(e)}
                        </label>
                      ))}
                    </div>
                  )}
                  {k === "hops" && !between.length && <div className="sub muted">No elements in between on this sheet.</div>}
                </div>
              ))}
              <div className="row">
                <button type="button" className="btn-ghost" onClick={() => onHidden([])}>Show all</button>
                <button type="button" className="btn-ghost" onClick={() => onHidden(["hops", "endPort", "nums"])}>Minimal</button>
              </div>
            </div>
          )}
        </Popover>
        <button type="button" onClick={exportSvg}>Download SVG</button>
        <button type="button" onClick={exportCsv}>CSV</button>
      </div>
      <div className="nd-paper">
        <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} fontFamily="Inter, Segoe UI, Arial, sans-serif" role="img" aria-label={`Port detail drawing of ${title}`}>
          <rect x={0} y={0} width={W} height={H} fill="#fff" />
          <rect x={6} y={6} width={W - 12} height={H - 12} fill="none" stroke={LINE} />
          <text x={MARGIN} y={34} fontSize={18} fontWeight={700} fill={INK}>Network detail — {title}</text>
          <text x={MARGIN} y={54} fontSize={11} fill={MUTED}>{centerInfo.filter(Boolean).join("   ·   ")}</text>
          <text x={MARGIN} y={top - 4} fontSize={10} fontWeight={700} fill={MUTED} letterSpacing={0.6}>TOWARD CLIENTS / MASTERS</text>
          <text x={W - MARGIN} y={top - 4} textAnchor="end" fontSize={10} fontWeight={700} fill={MUTED} letterSpacing={0.6}>TOWARD SERVERS / OUTSTATIONS</text>
          <rect x={cx} y={top} width={CENTER_W} height={centerH} rx={8} fill="#fff" stroke={color} strokeWidth={2} strokeDasharray={elem.kind === "custom" ? "6 4" : undefined} />
          <rect x={cx} y={top} width={CENTER_W} height={centerH} rx={8} fill={color} fillOpacity={0.08} />
          <rect x={cx} y={top} width={CENTER_W} height={6} rx={3} fill={color} />
          <text x={cx + CENTER_W / 2} y={top + centerH / 2 - 6} textAnchor="middle" fontSize={15} fontWeight={700} fill={INK}>{title}</text>
          <text x={cx + CENTER_W / 2} y={top + centerH / 2 + 12} textAnchor="middle" fontSize={10} fill={MUTED}>{(centerInfo[0] || "").slice(0, 40)}</text>
          <text x={cx + CENTER_W / 2} y={top + centerH / 2 + 26} textAnchor="middle" fontSize={10} fill={MUTED}>{(centerInfo[1] || "").slice(0, 40)}</text>
          {!routes.length && <text x={cx + CENTER_W / 2} y={top + centerH + 18} textAnchor="middle" fontSize={11} fill={MUTED}>Not part of any connection path yet.</text>}
          {drawSide(L, LL, "left")}
          {drawSide(R, RL, "right")}
          <text x={MARGIN} y={legendY} fontSize={10} fontWeight={700} fill={MUTED} letterSpacing={0.6}>VLANS</text>
          {legend.map(({ id, x, y }) => (
            <g key={id}>
              <rect x={x} y={y - 9} width={22} height={10} rx={5} fill={vlanColor.get(id) ?? MUTED} />
              <text x={x + 28} y={y} fontSize={10} fill={INK}>{legendText(id)}</text>
            </g>
          ))}
          {!usedVlans.length && <text x={MARGIN} y={legendY + 16} fontSize={10} fill={MUTED}>—</text>}
          <g>
            <rect x={W - MARGIN - 260} y={H - 58} width={260} height={46} fill="#fff" stroke={LINE} />
            <text x={W - MARGIN - 250} y={H - 40} fontSize={10} fontWeight={700} fill={INK}>NETWORK DETAIL · {title.toUpperCase().slice(0, 22)}</text>
            <text x={W - MARGIN - 250} y={H - 25} fontSize={9} fill={MUTED}>Generated from Data flow paths · {stampDate}</text>
          </g>
        </svg>
      </div>
      <table className="net nd-table">
        <thead>
          <tr><th>Port</th><th>Direction</th><th>Main VLAN</th><th>Via</th><th>End VLAN</th><th>End device</th><th>End port</th><th>Peer type</th><th>Service</th><th>Connections</th><th>Issues</th></tr>
        </thead>
        <tbody>
          {tableRows.map((rs, i) => {
            const r = rs[0];
            const e = dev(r.endId);
            const d = dmap.get(r.endId);
            const ed = editor.on;
            const issues = issuesOf(rs);
            const mainEditable = rs.every((x) => x.mainAt !== "hop");
            return (
              <tr key={i} className={issues.length ? "warnrow" : undefined}>
                <td className="mono">{ed ? <EditText value={r.port} label={`Port (row ${i + 1})`} onCommit={(v) => editor.setPort(rs.map((x) => x.selfRef), v)} /> : r.port || "(not specified)"}</td>
                <td>{r.dir === "toClient" ? "To clients" : "To servers"}</td>
                <td className="mono">{ed && mainEditable ? sel(`Main VLAN (row ${i + 1})`, r.mainVlan ?? "", [["", "—"], ...editor.vlanOpts], (v) => editor.setVlan(rs, "main", v)) : vlanText(r.mainVlan ? [r.mainVlan] : []) || <span className="muted">—</span>}</td>
                <td>{r.hops.length ? r.hops.map(nameOf).join(" › ") : <span className="muted">direct</span>}</td>
                <td className="mono">{ed ? sel(`End VLAN (row ${i + 1})`, r.endVlan ?? "", [["", "—"], ...editor.vlanOpts], (v) => editor.setVlan(rs, "end", v)) : vlanText(r.endVlan ? [r.endVlan] : []) || <span className="muted">—</span>}</td>
                <td>{ed ? sel(`End device (row ${i + 1})`, r.endId, editor.deviceOpts, (v) => editor.setEnd(rs, v)) : <b>{nameOf(e)}</b>}</td>
                <td className="mono">{ed ? <EditText value={r.endPort} label={`End port (row ${i + 1})`} onCommit={(v) => editor.setPort(rs.map((x) => x.endRef), v)} /> : r.endPort || <span className="muted">—</span>}</td>
                <td>{ed && d ? sel(`Peer type (row ${i + 1})`, d.categoryId ?? "", editor.catOpts, (v) => editor.setDevice(d.id, { categoryId: v || null })) : catOf(e)}</td>
                <td>{ed && d ? sel(`Service (row ${i + 1})`, d.serviceId ?? "", editor.svcOpts, (v) => editor.setDevice(d.id, { serviceId: v || null })) : svcOf(e)}</td>
                <td>
                  {[...new Set(rs.map((x) => x.connId))]
                    .map((id) => ({ id, n: numOf.get(id) }))
                    .filter((x) => x.n)
                    .sort((a, b) => a.n! - b.n!)
                    .map(({ id, n: num }) => {
                      const c = cmap.get(id)!;
                      const st = numStyle(numColors[id], pmap.get(c.protocolId ?? "")?.style.color ?? MUTED);
                      return <span key={id} className="sq" style={{ background: st.bg, color: st.fg }} title={protocolLabel(pmap.get(c.protocolId ?? ""))}>{num}</span>;
                    })}
                </td>
                <td>{issues.length ? <span className="chip err" title={issues.join("; ")}>{issues.join("; ")}</span> : <span className="muted">OK</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
