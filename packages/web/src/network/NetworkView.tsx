import {
  SERVICE_KINDS, chainOf, serviceColor, inactiveReason, treeRank, validateDevices, validateFirewalls, validateServices, validateVlans,
  type Device, type DeviceCategory, type Firewall, type Hierarchy, type RowIssues, type Service, type Vlan,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { EditGrid, ImportModal, issueCounts, type GridCol, type ImportField } from "../grid";
import { Seg, useLocal, useUi } from "../ui";
import { NET_SNAP, type NetSnap } from "../snapshots";
import { VersionBar } from "../VersionBar";
import { CategoryEditor } from "./CategoryEditor";
import { TreeView } from "./TreeView";

type Tab = "services" | "firewalls" | "vlans" | "devices" | "tree";
const KINDS: readonly string[] = SERVICE_KINDS;
type Row = Service | Firewall | Vlan | Device;

const NOTES = { key: "notes", label: "Notes", syn: ["notes", "note", "comment", "description"] };
const FIELDS: Record<Exclude<Tab, "tree">, ImportField[]> = {
  services: [
    { key: "contractor", label: "Contractor", syn: ["contractor", "company", "integrator", "vendor", "owner"] },
    { key: "name", label: "Service", syn: ["service", "name", "servicename", "network"] },
    { key: "kind", label: "Type", syn: ["type", "kind", "category"] },
    NOTES,
  ],
  firewalls: [
    { key: "name", label: "Name", syn: ["name", "firewall", "fw", "firewallname"] },
    { key: "serviceId", label: "Service", syn: ["service", "servicename", "network"] },
    { key: "vendorModel", label: "Vendor / model", syn: ["vendor", "model", "vendormodel", "make"] },
    { key: "mgmtIp", label: "Mgmt IP", syn: ["mgmtip", "managementip", "ip", "ipaddress"] },
    { key: "serial", label: "Serial number", syn: ["serial", "serialnumber", "sn", "serialno"] },
    NOTES,
  ],
  vlans: [
    { key: "firewallId", label: "Firewall", syn: ["firewall", "fw"] },
    { key: "vlan", label: "VLAN ID", syn: ["vlan", "vlanid", "id"] },
    { key: "name", label: "Name", syn: ["name", "vlanname"] },
    { key: "subnet", label: "Subnet", syn: ["subnet", "network", "cidr", "subnetcidr"] },
    { key: "gateway", label: "Gateway", syn: ["gateway", "gw"] },
    NOTES,
  ],
  devices: [
    { key: "name", label: "Name", syn: ["name", "device", "devicename"] },
    { key: "type", label: "Type", syn: ["type", "devicetype", "role"] },
    { key: "model", label: "Model", syn: ["model", "devicemodel", "make", "makemodel", "partnumber", "pn"] },
    { key: "serial", label: "Serial number", syn: ["serial", "serialnumber", "sn", "serialno"] },
    { key: "ip", label: "IP address", syn: ["ip", "ipaddress", "ipv4"] },
    { key: "categoryId", label: "Category", syn: ["category", "devicecategory", "class", "group"] },
    { key: "serviceId", label: "Service", syn: ["service", "servicename", "network"] },
    NOTES,
  ],
};
const NOUN: Record<Exclude<Tab, "tree">, [string, string]> = {
  services: ["service", "services"],
  firewalls: ["firewall", "firewalls"],
  vlans: ["VLAN", "VLANs"],
  devices: ["device", "devices"],
};
const EMPTY_TEXT: Record<Exclude<Tab, "tree">, string> = {
  services:
    "A service is a distinct network/solution in the project — Substation, EMS, QSE, ISO, SCADA, DAS, PLC — usually delivered by one contractor. Define services first, then their firewalls, VLANs and devices.",
  firewalls: "Each firewall belongs to a service. VLANs sit behind a firewall.",
  vlans: "Define VLANs with their firewall, subnet and gateway. Devices are placed in a VLAN automatically from their IP (within the device's service, when set).",
  devices: "Add each device with its type, serial number and IP. Set its service when external networks reuse the same subnets. Protocols and point lists are defined per connection in Data flow.",
};

/** Loads the whole network hierarchy. */
export function useNetwork(active: boolean) {
  const [h, setH] = useState<Hierarchy>({ services: [], firewalls: [], vlans: [], devices: [] });
  const [cats, setCats] = useState<DeviceCategory[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [services, firewalls, vlans, devices, categories] = await Promise.all([api.services.list(), api.firewalls.list(), api.vlans.list(), api.devices.list(), api.categories.list()]);
      setH({ services, firewalls, vlans, devices });
      setCats(categories);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  return { h, setH, cats, err, refresh };
}

export const serviceLabel = (s: Service | undefined) => (s ? `${s.name || "(unnamed)"}${s.contractor ? ` · ${s.contractor}` : ""}` : "");

export function NetworkView({ active }: { active: boolean }) {
  const ui = useUi();
  const [pref, setPref] = useLocal<{ tab: Tab; svc: string[]; cat?: string[]; closed?: string[] }>("fpl.net2", { tab: "services", svc: [] });
  const closed = pref.closed ?? [];
  const toggleGroup = (k: string) => setPref({ ...pref, closed: closed.includes(k) ? closed.filter((x) => x !== k) : [...closed, k] });
  const tab = pref.tab;
  const { h, setH, cats, err, refresh } = useNetwork(active);
  const [editCats, setEditCats] = useState(false);
  const cmap = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const cat = (pref.cat ?? []).filter((id) => cmap.has(id) || id === "none");
  const toggleCat = (id: string | null) => setPref({ ...pref, cat: id === null ? [] : cat.includes(id) ? cat.filter((x) => x !== id) : [...cat, id] });
  const inCat = (d: Device) => !cat.length || cat.includes(d.categoryId && cmap.has(d.categoryId) ? d.categoryId : "none");
  const { services, firewalls, vlans, devices } = h;
  const [importing, setImporting] = useState(false);

  const smap = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const fmap = useMemo(() => new Map(firewalls.map((f) => [f.id, f])), [firewalls]);
  const vmap = useMemo(() => new Map(vlans.map((v) => [v.id, v])), [vlans]);
  const rank = useMemo(() => treeRank(h), [h]);

  // Service filter for the lower tabs.
  const svc = pref.svc.filter((id) => smap.has(id) || id === "none");
  const inSvc = (sid: string | null | undefined) => !svc.length || svc.includes(sid ?? "none");
  const fwSvc = (f: Firewall) => f.serviceId;
  const vlanSvc = (v: Vlan) => (v.firewallId ? fmap.get(v.firewallId)?.serviceId ?? null : null);
  const devSvc = (d: Device) => chainOf(d, h).service?.id ?? null;
  const toggleSvc = (id: string | null) => setPref({ ...pref, svc: id === null ? [] : svc.includes(id) ? svc.filter((x) => x !== id) : [...svc, id] });

  const lists = useMemo(
    () => ({
      services: services.slice().sort(rank.services),
      firewalls: firewalls.slice().sort(rank.firewalls),
      vlans: vlans.slice().sort(rank.vlans),
      devices: devices.slice().sort(rank.devices),
    }),
    [services, firewalls, vlans, devices, rank],
  );

  /** Devices ordered by service, then category (as in the catalog), keeping network order within each. */
  function byServiceAndCategory(list: Device[]) {
    const so = new Map(lists.services.map((s, i) => [s.id as string | null, i]));
    const co = new Map(cats.map((c, i) => [c.id as string | null, i]));
    return list
      .map((d, i) => ({ d, i, s: so.get(devSvc(d)) ?? 1e9, c: co.get(d.categoryId ?? null) ?? 1e9 }))
      .sort((a, b) => a.s - b.s || a.c - b.c || a.i - b.i)
      .map((x) => x.d);
  }
  const catSection = (d: Device) => {
    const c = d.categoryId ? cmap.get(d.categoryId) : undefined;
    return { key: c?.id ?? "none", label: c ? <><i className="catdot" style={{ background: c.color, marginRight: 6 }} />{c.name}</> : <span className="muted">No category</span> };
  };

  const issues: RowIssues = useMemo(() => {
    switch (tab) {
      case "services": return validateServices(services);
      case "firewalls": return validateFirewalls(firewalls, services);
      case "vlans": return validateVlans(vlans, firewalls);
      case "devices": return validateDevices(devices, vlans, firewalls);
      default: return {};
    }
  }, [tab, services, firewalls, vlans, devices]);

  const rows: Row[] =
    tab === "services" ? lists.services
    : tab === "firewalls" ? lists.firewalls.filter((f) => inSvc(fwSvc(f)))
    : tab === "vlans" ? lists.vlans.filter((v) => inSvc(vlanSvc(v)))
    : tab === "devices" ? byServiceAndCategory(lists.devices.filter((d) => inSvc(devSvc(d)) && inCat(d)))
    : [];
  const { err: nErr, warn: nWarn } = issueCounts(Object.fromEntries(rows.map((r) => [r.id, issues[r.id] ?? []])));

  const svcOpts = (none: string): [string, string][] => [["", none], ...lists.services.map((s) => [s.id, serviceLabel(s)] as [string, string])];
  const fwLabel = (f: Firewall | undefined) => (f ? `${smap.get(f.serviceId ?? "")?.name ?? "—"} › ${f.name || "(unnamed)"}` : "");
  const fwOpts: [string, string][] = [["", "— none —"], ...lists.firewalls.map((f) => [f.id, fwLabel(f)] as [string, string])];
  const enabledCol = { key: "enabled", label: "Enabled", kind: "check" as const, title: "Inactive items (and everything under them) are greyed out in View all and left out of outputs" };

  const serviceCols: GridCol<Service>[] = [
    { key: "contractor", label: "Contractor (key)", title: "Contractor responsible for this service" },
    { key: "name", label: "Service" },
    { key: "kind", label: "Type", kind: "select", options: (s) => [...KINDS, ...(s.kind && !KINDS.includes(s.kind) ? [s.kind] : [])].map((k) => [k, k] as [string, string]) },
    { key: "color", label: "Colour", kind: "color", auto: (s) => serviceColor(s, services), title: "Device colour in the Data flow diagram" },
    { key: "notes", label: "Notes" },
    enabledCol,
  ];
  const firewallCols: GridCol<Firewall>[] = [
    { key: "name", label: "Name" },
    { key: "serviceId", label: "Service", kind: "select", options: () => svcOpts("— select —") },
    { key: "vendorModel", label: "Vendor / model" },
    { key: "mgmtIp", label: "Mgmt IP", mono: true },
    { key: "serial", label: "Serial number", mono: true },
    { key: "notes", label: "Notes" },
    enabledCol,
  ];
  const vlanCols: GridCol<Vlan>[] = [
    { key: "firewallId", label: "Service › Firewall", kind: "select", options: () => fwOpts },
    { key: "vlan", label: "VLAN ID", mono: true },
    { key: "name", label: "Name" },
    { key: "subnet", label: "Subnet (CIDR)", mono: true, placeholder: () => "10.10.20.0/24" },
    { key: "gateway", label: "Gateway", mono: true },
    { key: "notes", label: "Notes" },
    enabledCol,
  ];
  const deviceCols: GridCol<Device>[] = [
    { key: "name", label: "Name" },
    { key: "type", label: "Type", placeholder: () => "PCS, BMS, meter…" },
    { key: "model", label: "Model" },
    { key: "serial", label: "Serial number", mono: true },
    { key: "ip", label: "IP address", mono: true },
    {
      key: "categoryId",
      label: "Category",
      kind: "select",
      options: (d) => [["", "— none —"], ...cats.map((c) => [c.id, c.name] as [string, string]), ...(d.categoryId && !cmap.has(d.categoryId) ? [[d.categoryId, "?"] as [string, string]] : [])],
    },
    { key: "serviceId", label: "Service", kind: "select", title: "Optional. Limits VLAN matching to this service's VLANs.", options: () => svcOpts("— any —") },
    {
      key: "vlanId",
      label: "VLAN (auto)",
      kind: "readonly",
      title: "Assigned from the VLAN whose subnet contains the IP (within the device's service, when set). Edit subnets in the VLANs tab.",
      display: (d) => {
        const v = d.vlanId ? vmap.get(d.vlanId) : undefined;
        return v ? `${v.vlan} · ${v.name}` : d.ip ? "— no matching subnet —" : "";
      },
    },
    { key: "firewall", label: "Firewall (auto)", kind: "readonly", display: (d) => chainOf(d, h).firewall?.name ?? "" },
    { key: "notes", label: "Notes" },
    enabledCol,
  ];

  const store = tab === "tree" ? null : api[tab];
  const save = async (id: string, key: string, value: string | boolean) => {
    if (!store) return;
    try {
      const v = typeof value === "string" && key.endsWith("Id") ? value || null : value;
      await (store.update as (id: string, b: Record<string, unknown>) => Promise<unknown>)(id, { [key]: v });
      // Any change can move devices between VLANs (subnets, firewall/service links), so reload everything.
      await refresh();
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    }
  };
  const add = async () => {
    if (!store) return;
    // New rows inherit the filter when exactly one service is selected.
    const one = svc.length === 1 && svc[0] !== "none" ? svc[0] : null;
    const body: Record<string, unknown> = {};
    if (one && (tab === "firewalls" || tab === "devices")) body.serviceId = one;
    if (one && tab === "vlans") {
      const fws = firewalls.filter((f) => f.serviceId === one);
      if (fws.length === 1) body.firewallId = fws[0].id;
    }
    if (tab === "services") body.kind = "Substation";
    if (tab === "devices" && cat.length === 1 && cat[0] !== "none") body.categoryId = cat[0];
    try {
      await (store.create as (b: Record<string, unknown>) => Promise<unknown>)(body);
      await refresh();
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const remove = async (r: Row) => {
    if (!store) return;
    const label =
      tab === "vlans" ? `VLAN ${(r as Vlan).vlan || "(no ID)"}` : (r as Service).name || `this ${NOUN[tab as Exclude<Tab, "tree">][0]}`;
    const extra =
      tab === "services" ? " Its firewalls and devices become unassigned."
      : tab === "firewalls" ? " Its VLANs become unassigned."
      : tab === "vlans" ? " Devices in its subnet become unassigned."
      : " Its data-flow connections are deleted too.";
    if (!(await ui.confirm(`Delete ${label}?${extra}`, "Delete"))) return;
    await store.remove(r.id);
    refresh();
  };

  const byName = <T extends { id: string; name: string }>(list: T[], v: string) => list.find((x) => x.name.trim().toLowerCase() === v.trim().toLowerCase())?.id ?? null;
  const convert = (raw: Record<string, string>): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...raw };
    if ("serviceId" in raw) o.serviceId = raw.serviceId ? byName(services, raw.serviceId) : null;
    if ("categoryId" in raw) o.categoryId = raw.categoryId ? byName(cats, raw.categoryId) : null;
    if ("firewallId" in raw) o.firewallId = raw.firewallId ? byName(firewalls, raw.firewallId) : null;
    if (tab === "services") {
      const k = SERVICE_KINDS.find((x) => x.toLowerCase() === (raw.kind ?? "").trim().toLowerCase());
      o.kind = k ?? (raw.kind?.trim() || "Other");
    }
    return o;
  };

  const rowStyle = (r: Row): React.CSSProperties | undefined => {
    if (tab === "devices") return inactiveReason(r as Device, h) ? { opacity: 0.5 } : undefined;
    return (r as Service).enabled === false ? { opacity: 0.5 } : undefined;
  };
  const rowTitle = (r: Row) => (tab === "devices" ? inactiveReason(r as Device, h) || undefined : (r as Service).enabled === false ? "Inactive" : undefined);

  const count = (t: Exclude<Tab, "tree">) => h[t].length;
  const grid = (() => {
    const common = { issues, onSave: save, onDelete: remove, rowStyle, rowTitle, collapsed: closed, onToggleGroup: toggleGroup };
    // Lower tabs are grouped by service when more than one service is shown.
    const grp = (sid: string | null | undefined) => {
      const s = sid ? smap.get(sid) : undefined;
      return { key: s?.id ?? "none", label: s ? <>{s.name || "(unnamed)"} <span className="muted">· {s.kind}{s.contractor ? ` · ${s.contractor}` : ""}</span></> : <span className="muted">No service</span> };
    };
    if (tab === "services") return <EditGrid rows={rows as Service[]} cols={serviceCols} {...common} />;
    if (tab === "firewalls") return <EditGrid rows={rows as Firewall[]} cols={firewallCols} {...common} group={(f) => grp(fwSvc(f))} />;
    if (tab === "vlans") return <EditGrid rows={rows as Vlan[]} cols={vlanCols} {...common} group={(v) => grp(vlanSvc(v))} />;
    return <EditGrid rows={rows as Device[]} cols={deviceCols} {...common} group={(d) => grp(devSvc(d))} sub={catSection} />;
  })();

  return (
    <section className="view simple" aria-label="Network">
      <header className="toolbar">
        <h1>Network</h1>
        <Seg
          label="Object type"
          value={tab}
          options={[
            ["services", `Services (${count("services")})`],
            ["firewalls", `Firewalls (${count("firewalls")})`],
            ["vlans", `VLANs (${count("vlans")})`],
            ["devices", `Devices (${count("devices")})`],
            ["tree", "View all"],
          ]}
          onChange={(t) => setPref({ ...pref, tab: t })}
        />
        <VersionBar<NetSnap>
          {...NET_SNAP}
          data={err ? null : { ...h, categories: cats }}
          restore={async (snap) => {
            const r = await api.restoreNetwork(snap);
            await refresh();
            if (r.removed.connections) ui.toast(`${r.removed.connections} connection(s) to removed devices were deleted`);
          }}
        />
        {tab !== "tree" && (
          <>
            {nErr > 0 && <span className="chip err">{nErr} errors</span>}
            {nWarn > 0 && <span className="chip">{nWarn} warnings</span>}
            {!nErr && !nWarn && rows.length > 0 && <span className="chip info">No problems found</span>}
            <span className="grow" />
            {tab === "devices" && <button type="button" onClick={() => setEditCats(true)} title="Add, rename, recolour or delete device categories">Categories…</button>}
            <button type="button" onClick={() => setImporting(true)}>Import rows…</button>
            <button type="button" className="btn-primary" onClick={add}>Add {NOUN[tab][0]}</button>
          </>
        )}
      </header>
      {tab !== "tree" && tab !== "services" && (services.length > 0 || tab === "devices") && (
        <div className="toolbar sub">
          {services.length > 0 && (
          <div className="bubbles" role="group" aria-label="Filter by service">
            <span className="muted" style={{ fontSize: 12 }}>Service</span>
            <button type="button" className="bubble" aria-pressed={!svc.length} onClick={() => toggleSvc(null)}>All</button>
            {lists.services.map((s) => (
              <button key={s.id} type="button" className="bubble" aria-pressed={svc.includes(s.id)} title={`${s.kind}${s.contractor ? ` · ${s.contractor}` : ""}`} onClick={() => toggleSvc(s.id)}>
                {s.name || "(unnamed)"}
              </button>
            ))}
            <button type="button" className="bubble" aria-pressed={svc.includes("none")} onClick={() => toggleSvc("none")}>Unassigned</button>
          </div>
          )}
          {tab === "devices" && (
            <div className="bubbles" role="group" aria-label="Filter by category">
              <span className="muted" style={{ fontSize: 12 }}>Category</span>
              <button type="button" className="bubble" aria-pressed={!cat.length} onClick={() => toggleCat(null)}>All</button>
              {cats.map((c) => (
                <button key={c.id} type="button" className="bubble" aria-pressed={cat.includes(c.id)} onClick={() => toggleCat(c.id)}>
                  <i style={{ background: c.color }} />{c.name}
                </button>
              ))}
              <button type="button" className="bubble" aria-pressed={cat.includes("none")} onClick={() => toggleCat("none")}>None</button>
              <button type="button" className="bubble edit" onClick={() => setEditCats(true)}>Edit…</button>
            </div>
          )}
        </div>
      )}
      <section className="pane">
        {err ? (
          <div className="scroll"><div className="empty-state"><h3>Can’t reach the server</h3><p>{err}</p><button type="button" onClick={refresh}>Retry</button></div></div>
        ) : tab === "tree" ? (
          <TreeView h={h} setH={setH} refresh={refresh} />
        ) : (
          <div className="scroll">
            {!h[tab].length ? (
              <div className="empty-state">
                <h3>No {NOUN[tab][1]} yet</h3>
                <p>{EMPTY_TEXT[tab]}</p>
                <div className="toolbar"><button type="button" className="btn-primary" onClick={add}>Add {NOUN[tab][0]}</button><button type="button" onClick={() => setImporting(true)}>Import rows…</button></div>
              </div>
            ) : !rows.length ? (
              <div className="empty-state"><p>No {NOUN[tab][1]} in the selected services.</p><button type="button" onClick={() => toggleSvc(null)}>Show all</button></div>
            ) : (
              grid
            )}
          </div>
        )}
      </section>
      {editCats && <CategoryEditor categories={cats} devices={devices} onChanged={refresh} onClose={() => setEditCats(false)} />}
      {importing && tab !== "tree" && (
        <ImportModal
          title={`Import ${NOUN[tab][1]}`}
          fields={FIELDS[tab]}
          note={
            tab === "devices" ? "Service and Category match by name; VLANs are assigned automatically from each IP."
            : tab === "firewalls" ? "Service matches service names."
            : tab === "vlans" ? "Firewall matches firewall names."
            : undefined
          }
          convert={convert}
          onImport={async (r) => {
            await (store!.import as (rows: Record<string, unknown>[]) => Promise<unknown>)(r);
            await refresh();
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </section>
  );
}
