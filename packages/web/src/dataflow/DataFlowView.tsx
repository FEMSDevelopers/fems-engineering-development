import { expandProtocols, inactiveReason, normName, pathText, validateConnections, type Connection, type DeviceCategory, type Hierarchy, type ProtocolDef } from "@fpl/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type SourceMeta } from "../api";
import { DF_SNAP, NET_SNAP, type DfSnap } from "../snapshots";
import { saveSubversionDirect, VersionBar, type VersionBarHandle } from "../VersionBar";
import { EditGrid, ImportModal, issueCounts, type GridCol, type ImportField } from "../grid";
import { Seg, useLocal, useUi } from "../ui";
import { ColumnsModal, normalizeLayout, useColumnPresets, type ColLayout } from "./ColumnsModal";
import { Diagram } from "./Diagram";
import { NetworkDetails } from "./NetworkDetails";
import { ConnectionEditor, hopNamer } from "./PathEditor";
import { defaultPortOf, orderedProtocols } from "./draw";
import { ProtocolEditor } from "./ProtocolEditor";

type Tab = "list" | "diagram" | "netdetail";

const FIELDS: ImportField[] = [
  { key: "fromId", label: "From", syn: ["from", "client", "master", "source", "fromdevice", "publisher"] },
  { key: "toId", label: "To", syn: ["to", "server", "slave", "outstation", "todevice", "destination", "broker"] },
  { key: "protocolId", label: "Protocol", syn: ["protocol", "proto"] },
  { key: "port", label: "Port", syn: ["port", "tcpport"] },
  { key: "address", label: "Unit / address", syn: ["unit", "unitid", "slaveid", "address", "outstationaddress", "commonaddress", "ca"] },
  { key: "sourceId", label: "Point list", syn: ["pointlist", "map", "registermap"] },
  { key: "topic", label: "MQTT topic", syn: ["mqtt", "mqtttopic", "topic", "basetopic"] },
  { key: "bidirectional", label: "Bidirectional", syn: ["bidirectional", "bidir", "twoway"] },
  { key: "notes", label: "Notes", syn: ["notes", "note", "comment"] },
  { key: "clientPort", label: "Client port", syn: ["clientport", "fromport", "masterport"] },
  { key: "serverPort", label: "Server port", syn: ["serverport", "toport", "outstationport"] },
];

/** Columns hidden until switched on in Manage columns. */
const DEFAULT_HIDDEN = ["path"];

export function DataFlowView({ active }: { active: boolean }) {
  const ui = useUi();
  const [pref, setPref] = useLocal<{ tab: Tab; filter: string[] }>("fpl.dataflow", { tab: "list", filter: [] });
  const [h, setH] = useState<Hierarchy>({ services: [], firewalls: [], vlans: [], devices: [] });
  const { devices, vlans } = h;
  const [colPref, setColPref] = useLocal<{ layout?: ColLayout; preset: string }>("fpl.dataflow.cols", { preset: "" });
  const { presets, reload: reloadPresets } = useColumnPresets();
  const [managing, setManaging] = useState(false);
  /** Connection open in the dialog: an id, "new", or null. */
  const [editFor, setEditFor] = useState<string | null>(null);
  const [cats, setCats] = useState<DeviceCategory[]>([]);
  const [conns, setConns] = useState<Connection[]>([]);
  const [protocols, setProtocols] = useState<ProtocolDef[]>([]);
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [editProto, setEditProto] = useState(false);
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dfBar = useRef<VersionBarHandle>(null);
  /** After Network details edits are written: reload, then record a sub-version of the connection list and of the network. */
  const afterDetailEdit = async (note: string) => {
    await refresh();
    const fresh = await api.connections.list();
    await dfBar.current?.saveSubversion(note, { connections: fresh });
    const [services, firewalls, vlans, devices, categories] = await Promise.all([api.services.list(), api.firewalls.list(), api.vlans.list(), api.devices.list(), api.categories.list()]);
    const v = await saveSubversionDirect({ ...NET_SNAP, data: { services, firewalls, vlans, devices, categories }, note });
    ui.toast(`Saved connection list (${fresh.length} connections) and network v${v.major}.${String(v.minor).padStart(3, "0")}`);
  };
  const refresh = useCallback(async () => {
    try {
      const [sv, fw, v, d, c, p, s] = await Promise.all([
        api.services.list(), api.firewalls.list(), api.vlans.list(), api.devices.list(),
        api.connections.list(), api.protocols.list(), api.sources.list(),
      ]);
      setCats(await api.categories.list());
      setH({ services: sv, firewalls: fw, vlans: v, devices: d });
      setConns(c);
      setProtocols(p);
      setSources(s);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  const ordered = useMemo(() => orderedProtocols(protocols), [protocols]);
  const pmap = useMemo(() => new Map(protocols.map((p) => [p.id, p])), [protocols]);
  const filter = pref.filter.filter((id) => pmap.has(id));
  const visible = useMemo(() => (filter.length ? expandProtocols(filter, protocols) : null), [filter, protocols]);
  const rows = conns.filter((c) => !visible || (c.protocolId && visible.has(c.protocolId)));
  const kinds = useMemo(() => Object.fromEntries(sources.map((s) => [s.id, s.kind])), [sources]);
  const issues = useMemo(() => validateConnections(conns, devices, protocols, kinds, h.firewalls.map((f) => f.id), vlans), [conns, devices, protocols, kinds, h.firewalls, vlans]);
  const { err: nErr, warn: nWarn } = issueCounts(Object.fromEntries(rows.map((r) => [r.id, issues[r.id] ?? []])));
  const usage = useMemo(() => {
    const u: Record<string, number> = {};
    conns.forEach((c) => c.protocolId && (u[c.protocolId] = (u[c.protocolId] ?? 0) + 1));
    return u;
  }, [conns]);

  const toggle = (id: string | null) =>
    setPref({ ...pref, filter: id === null ? [] : filter.includes(id) ? filter.filter((x) => x !== id) : [...filter, id] });

  const off = useMemo(() => new Map(devices.map((d) => [d.id, inactiveReason(d, h)])), [devices, h]);
  const nameOf = useMemo(() => hopNamer(h), [h]);
  // The diagram only shows devices whose service → firewall → VLAN → device chain is all enabled.
  const activeDevices = useMemo(() => devices.filter((d) => !off.get(d.id)), [devices, off]);
  const activeConns = useMemo(() => conns.filter((c) => !off.get(c.fromId ?? "") && !off.get(c.toId ?? "")), [conns, off]);

  const hopCell = (c: Connection, end: "client" | "server") => {
    const path = c.path ?? [];
    const hop = end === "client" ? path[0] : path[path.length - 1];
    const port = hop ? (end === "client" ? hop.inPort : hop.outPort) : "";
    const label = end === "client" ? "Client connected to" : "Server connected to";
    return (
      <span className="hopcell" title={path.length ? pathText(c, nameOf) : "No path defined yet"}>
        {hop ? (
          <span className="hn">
            {(hop.kind === "custom" ? hop.label || "custom trajectory" : nameOf(hop.kind, hop.id))}
            {port && <span className="mono muted"> · {port}</span>}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
        <button type="button" className="ed" aria-label={`Edit connection (${label})`} title="Edit client, server, ports and path" onClick={() => setEditFor(c.id)}>✎</button>
      </span>
    );
  };
  const endCell = (c: Connection, end: "from" | "to") => {
    const d = devices.find((x) => x.id === (end === "from" ? c.fromId : c.toId));
    return (
      <span className="endcell" title={d ? off.get(d.id) || undefined : undefined}>
        {d ? <span>{d.name || "(unnamed)"}</span> : <span className="muted">— not set —</span>}
        {d?.ip && <span className="ip">{d.ip}</span>}
        <button type="button" className="ed" aria-label={`Edit connection (${end === "from" ? "From" : "To"})`} title="Edit client, server, ports and path" onClick={() => setEditFor(c.id)}>✎</button>
      </span>
    );
  };
  const allCols: GridCol<Connection>[] = [
    { key: "fromId", label: "From (client / master)", kind: "custom", render: (c) => endCell(c, "from"), title: "Defined in the connection dialog (✎)" },
    { key: "clientPort", label: "Client port", kind: "readonly", display: (c) => c.clientPort ?? "", title: "Port on the client device — set in the connection dialog" },
    { key: "clientTo", label: "Client connected to", kind: "custom", field: "path", render: (c) => hopCell(c, "client"), title: "First hop of the path (and its port)" },
    { key: "toId", label: "To (server / outstation)", kind: "custom", render: (c) => endCell(c, "to"), title: "Defined in the connection dialog (✎)" },
    { key: "serverPort", label: "Server port", kind: "readonly", display: (c) => c.serverPort ?? "", title: "Port on the server device — set in the connection dialog" },
    { key: "serverTo", label: "Server connected to", kind: "custom", field: "path", render: (c) => hopCell(c, "server"), title: "Last hop of the path (and its port)" },
    {
      key: "protocolId",
      label: "Protocol",
      kind: "select",
      options: () => [["", "— select —"], ...ordered.map((p) => [p.id, `${"  ".repeat(p.depth)}${p.name}${p.dfAlias ? ` (${p.dfAlias})` : ""}`] as [string, string])],
    },
    { key: "port", label: "Port", mono: true, placeholder: (c) => defaultPortOf(pmap.get(c.protocolId ?? ""), protocols) },
    { key: "address", label: "Unit / address", mono: true },
    {
      key: "sourceId",
      label: "Point list",
      kind: "select",
      options: () => [["", "— none —"], ...sources.filter((s) => s.kind !== "generic").map((s) => [s.id, s.name] as [string, string])],
    },
    { key: "topic", label: "MQTT topic", mono: true, title: "Base topic for this data, e.g. site/pcs01; each point publishes to <topic>/<tag>" },
    { key: "bidirectional", label: "Bidir.", kind: "check", title: "Communication in both directions" },
    { key: "notes", label: "Notes" },
    {
      key: "path",
      label: "Full path",
      kind: "custom",
      render: (c) => (
        <span className="hopcell">
          <span className="mono" style={{ whiteSpace: "normal", minWidth: "26em", display: "inline-block" }}>{(c.path ?? []).length ? pathText(c, nameOf) : <span className="muted">—</span>}</span>
          <button type="button" className="ed" aria-label="Edit connection (path)" onClick={() => setEditFor(c.id)}>✎</button>
        </span>
      ),
    },
  ];
  const colKeys = allCols.map((c) => c.key);
  const defaults: ColLayout = { order: colKeys, hidden: DEFAULT_HIDDEN };
  const layout = normalizeLayout(colPref.layout, colKeys, DEFAULT_HIDDEN);
  const cols = layout.order.filter((k) => !layout.hidden.includes(k)).map((k) => allCols.find((c) => c.key === k)!);
  const applyPreset = (name: string) => {
    const p = presets.find((x) => x.name === name);
    if (p) setColPref({ layout: normalizeLayout(p.data, colKeys, DEFAULT_HIDDEN), preset: p.name });
  };

  const save = async (id: string, key: string, value: string | boolean) => {
    try {
      const body = { [key]: typeof value === "string" && key.endsWith("Id") ? value || null : value } as Partial<Connection>;
      const r = await api.connections.update(id, body);
      setConns((l) => l.map((x) => (x.id === id ? r : x)));
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    }
  };
  // New connections are defined in the dialog; they default to the single selected filter protocol.
  const add = () => setEditFor("new");
  const remove = async (c: Connection) => {
    const d = (id: string | null) => devices.find((x) => x.id === id)?.name || "?";
    if (!(await ui.confirm(`Delete connection ${d(c.fromId)} → ${d(c.toId)}?`, "Delete"))) return;
    await api.connections.remove(c.id);
    setConns(conns.filter((x) => x.id !== c.id));
  };

  const findDevice = (v: string) => devices.find((d) => d.name === v || d.ip === v)?.id ?? null;
  const findProtocol = (v: string) => protocols.find((p) => [p.name, p.alias, p.dfAlias].some((x) => x && normName(x) === normName(v)))?.id ?? null;

  return (
    <section className="view simple df" aria-label="Data flow">
      {/* Row 1: views and versions */}
      <header className="toolbar df-row1">
        <h1>Data flow</h1>
        <Seg label="View" value={pref.tab} options={[["list", `Connection list (${conns.length})`], ["diagram", "Diagram"], ["netdetail", "Network details"]]} onChange={(t) => setPref({ ...pref, tab: t })} />
        <span className="grow" />
        <VersionBar<DfSnap>
          {...DF_SNAP}
          handle={dfBar}
          data={err ? null : { connections: conns }}
          restore={async (snap) => {
            const r = await api.restoreConnections(snap.connections ?? []);
            await refresh();
            if (r.cleared) ui.toast(`${r.cleared} reference(s) to deleted devices, protocols or VLANs were cleared`);
          }}
        />
      </header>
      {/* Row 2: global filters and page settings */}
      <div className="toolbar df-row2" role="toolbar" aria-label="Filters and settings">
          <div className="bubbles" role="group" aria-label="Filter by protocol">
          <button type="button" className="bubble" aria-pressed={!filter.length} onClick={() => toggle(null)}>Show all</button>
          {ordered.map((p) => (
            <button key={p.id} type="button" className="bubble" aria-pressed={filter.includes(p.id)} title={`${p.name}${p.alias ? ` · alias ${p.alias}` : ""}${usage[p.id] ? ` · ${usage[p.id]} connection(s)` : ""}`} onClick={() => toggle(p.id)}>
              <i style={{ background: p.style.color }} />
              {p.alias || p.name}
            </button>
          ))}
          <button type="button" className="bubble edit" onClick={() => setEditProto(true)} title="Add, rename or delete protocols and set their line style">Edit…</button>
        </div>
        <span className="grow" />
        {pref.tab === "list" && (
          <>
            {presets.length > 0 && (
              <select aria-label="Column layout" value={presets.some((p) => p.name === colPref.preset) ? colPref.preset : ""} onChange={(e) => applyPreset(e.target.value)} title="Load a saved column layout">
                <option value="">Layout…</option>
                {presets.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            )}
            <button type="button" onClick={() => setManaging(true)} title="Show, hide and reorder columns; save layouts">Columns…</button>
            {nErr > 0 && <span className="chip err">{nErr} errors</span>}
            {nWarn > 0 && <span className="chip">{nWarn} warnings</span>}
            <button type="button" onClick={() => setImporting(true)}>Import rows…</button>
            <button type="button" className="btn-primary" onClick={add}>Add connection</button>
          </>
        )}
      </div>
      <section className="pane">
        {err ? (
          <div className="empty-state"><h3>Can’t reach the server</h3><p>{err}</p><button type="button" onClick={refresh}>Retry</button></div>
        ) : pref.tab === "list" ? (
          <div className="scroll">
            {!conns.length ? (
              <div className="empty-state">
                <h3>No connections yet</h3>
                <p>Each connection is one directional communication: From (client / master / publisher) → To (server / outstation / broker), with its protocol, port, address, point list and MQTT topic.</p>
                {devices.length < 2 && <p>Add at least two devices in Network → Devices first.</p>}
                <div className="toolbar"><button type="button" className="btn-primary" onClick={add}>Add connection</button><button type="button" onClick={() => setImporting(true)}>Import rows…</button></div>
              </div>
            ) : !rows.length ? (
              <div className="empty-state"><p>No connections match the selected protocols.</p><button type="button" onClick={() => toggle(null)}>Show all</button></div>
            ) : (
              <EditGrid
                rows={rows}
                cols={cols}
                issues={issues}
                onSave={save}
                onDelete={remove}
                rowStyle={(c) => ({
                  boxShadow: `inset 3px 0 0 ${pmap.get(c.protocolId ?? "")?.style.color ?? "transparent"}`,
                  opacity: off.get(c.fromId ?? "") || off.get(c.toId ?? "") ? 0.5 : undefined,
                })}
                rowTitle={(c) => {
                  const why = [off.get(c.fromId ?? "") && `client: ${off.get(c.fromId ?? "")}`, off.get(c.toId ?? "") && `server: ${off.get(c.toId ?? "")}`].filter(Boolean);
                  return why.length ? `Inactive — ${why.join("; ")}` : undefined;
                }}
              />
            )}
          </div>
        ) : pref.tab === "netdetail" ? (
          <NetworkDetails h={h} devices={activeDevices} connections={activeConns} protocols={protocols} cats={cats} onApplied={afterDetailEdit} />
        ) : (
          <Diagram h={h} cats={cats} onNetChanged={refresh} devices={activeDevices} vlans={vlans} connections={activeConns} protocols={protocols} visible={visible} active={active && pref.tab === "diagram"} />
        )}
      </section>
      {managing && (
        <ColumnsModal
          cols={allCols.map((c) => ({ key: c.key, label: c.label }))}
          layout={layout}
          defaults={defaults}
          current={colPref.preset}
          presets={presets}
          reloadPresets={reloadPresets}
          onApply={(l, name) => setColPref({ layout: l, preset: name })}
          onClose={() => setManaging(false)}
        />
      )}
      {editFor && (editFor === "new" || conns.some((c) => c.id === editFor)) && (
        <ConnectionEditor
          conn={editFor === "new" ? null : conns.find((c) => c.id === editFor)!}
          defaults={filter.length === 1 ? { protocolId: filter[0] } : undefined}
          h={h}
          cats={cats}
          protocols={protocols}
          onSaved={(r, created) => setConns((l) => (created ? [...l, r] : l.map((x) => (x.id === r.id ? r : x))))}
          onClose={() => setEditFor(null)}
        />
      )}
      {editProto && <ProtocolEditor protocols={protocols} usage={usage} onClose={() => setEditProto(false)} onSaved={refresh} />}
      {importing && (
        <ImportModal
          title="Import connections"
          fields={FIELDS}
          note="From/To match device names (or IPs); Protocol matches name, alias or DF alias; Point list matches source names."
          convert={(raw) => ({
            fromId: raw.fromId ? findDevice(raw.fromId) : null,
            toId: raw.toId ? findDevice(raw.toId) : null,
            protocolId: raw.protocolId ? findProtocol(raw.protocolId) : null,
            port: raw.port ?? "",
            address: raw.address ?? "",
            sourceId: raw.sourceId ? sources.find((s) => s.name === raw.sourceId)?.id ?? null : null,
            topic: raw.topic ?? "",
            bidirectional: /^(y|yes|true|1|x)$/i.test(raw.bidirectional ?? ""),
            notes: raw.notes ?? "",
            clientPort: raw.clientPort ?? "",
            serverPort: raw.serverPort ?? "",
          })}
          onImport={async (r) => {
            await api.connections.import(r as Partial<Connection>[]);
            await refresh();
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </section>
  );
}
