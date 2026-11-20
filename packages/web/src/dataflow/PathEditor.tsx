import {
  chainOf, inCidr, inactiveReason, parseCidr, parseIp, pathText, treeRank,
  type Connection, type Device, type DeviceCategory, type Firewall, type Hierarchy, type PathHop, type ProtocolDef, type Vlan,
} from "@fpl/core";
import { Fragment, useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { Modal, Seg, useUi } from "../ui";
import { orderedProtocols } from "./draw";

type Filter = "service" | "category" | "firewall" | "vlan";

export function hopNamer(h: Hierarchy) {
  const d = new Map(h.devices.map((x) => [x.id, x.name || x.ip || "(unnamed)"]));
  const f = new Map(h.firewalls.map((x) => [x.id, x.name || "(unnamed firewall)"]));
  return (kind: PathHop["kind"], id: string | null) => (kind === "custom" ? "custom trajectory" : id ? (kind === "firewall" ? f.get(id) : d.get(id)) ?? "?" : "?");
}

/**
 * One dialog for a connection: protocol, client (From) and its port, the hops in between (devices / firewalls with
 * in-only or in/out ports) and the server (To) and its port. IPs and VLANs come from the Network module.
 */
export function ConnectionEditor({
  conn, defaults, h, cats, protocols, onSaved, onClose,
}: {
  /** null = new connection */
  conn: Connection | null;
  defaults?: Partial<Connection>;
  h: Hierarchy;
  cats: DeviceCategory[];
  protocols: ProtocolDef[];
  onSaved: (c: Connection, created: boolean) => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const init = { ...(defaults ?? {}), ...(conn ?? {}) };
  const [fromId, setFromId] = useState<string>(init.fromId ?? "");
  const [toId, setToId] = useState<string>(init.toId ?? "");
  const [protocolId, setProtocolId] = useState<string>(init.protocolId ?? "");
  const [clientPort, setClientPort] = useState(init.clientPort ?? "");
  const [serverPort, setServerPort] = useState(init.serverPort ?? "");
  const [hops, setHops] = useState<PathHop[]>(init.path ?? []);
  const [endNet, setEndNet] = useState(!!init.endNet);
  const [clientIp, setClientIp] = useState(init.clientIp ?? "");
  const [clientVlanId, setClientVlanId] = useState(init.clientVlanId ?? "");
  const [serverIp, setServerIp] = useState(init.serverIp ?? "");
  const [serverVlanId, setServerVlanId] = useState(init.serverVlanId ?? "");
  const [sel, setSel] = useState<Record<Filter, string[]>>({ service: [], category: [], firewall: [], vlan: [] });
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  const nameOf = useMemo(() => hopNamer(h), [h]);
  const rank = useMemo(() => treeRank(h), [h]);
  const svc = useMemo(() => new Map(h.services.map((s) => [s.id, s])), [h]);
  const fwm = useMemo(() => new Map(h.firewalls.map((f) => [f.id, f])), [h]);
  const vl = useMemo(() => new Map(h.vlans.map((v) => [v.id, v])), [h]);
  const dev = useMemo(() => new Map(h.devices.map((d) => [d.id, d])), [h]);
  const cmap = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const services = useMemo(() => h.services.slice().sort(rank.services), [h, rank]);
  const firewalls = useMemo(() => h.firewalls.slice().sort(rank.firewalls), [h, rank]);
  const vlans = useMemo(() => h.vlans.slice().sort(rank.vlans), [h, rank]);
  const devices = useMemo(() => h.devices.slice().sort(rank.devices), [h, rank]);

  // ---- filters ------------------------------------------------------------------
  const fwOk = (id: string, s = sel) => !s.service.length || s.service.includes(fwm.get(id)?.serviceId ?? "");
  const vlanOk = (id: string, s = sel) => {
    const f = fwm.get(vl.get(id)?.firewallId ?? "");
    return (!s.firewall.length || s.firewall.includes(f?.id ?? "")) && (!s.service.length || s.service.includes(f?.serviceId ?? ""));
  };
  const toggle = (k: Filter, id: string | null) =>
    setSel((s) => {
      const next = { ...s, [k]: id === null ? [] : s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] };
      if (k === "service") next.firewall = next.firewall.filter((f) => fwOk(f, next));
      if (k === "service" || k === "firewall") next.vlan = next.vlan.filter((v) => vlanOk(v, next));
      return next;
    });
  const devSvc = (d: Device) => chainOf(d, h).service?.id ?? null;
  const devOk = (d: Device) => {
    const c = chainOf(d, h);
    const cat = d.categoryId && cmap.has(d.categoryId) ? d.categoryId : "none";
    return (
      (!sel.service.length || sel.service.includes(c.service?.id ?? "")) &&
      (!sel.firewall.length || sel.firewall.includes(c.firewall?.id ?? "")) &&
      (!sel.vlan.length || sel.vlan.includes(d.vlanId ?? "")) &&
      (!sel.category.length || sel.category.includes(cat))
    );
  };
  const fwCand = (f: Firewall) =>
    fwOk(f.id) && (!sel.firewall.length || sel.firewall.includes(f.id)) && (!sel.vlan.length || sel.vlan.some((v) => vl.get(v)?.firewallId === f.id));

  // ---- labels -------------------------------------------------------------------
  const devLabel = (d: Device) => {
    const v = d.vlanId ? vl.get(d.vlanId) : undefined;
    const c = d.categoryId ? cmap.get(d.categoryId) : undefined;
    return [d.name || "(unnamed)", d.ip, v && `VLAN ${v.vlan}`, c?.name].filter(Boolean).join(" · ") + (inactiveReason(d, h) ? " (inactive)" : "");
  };
  const fwLabel = (f: Firewall) => `[FW] ${f.name || "(unnamed)"}${f.mgmtIp ? ` · ${f.mgmtIp}` : ""}${f.enabled === false ? " (inactive)" : ""}`;
  const svcName = (id: string | null) => {
    const s = id ? svc.get(id) : undefined;
    return s ? `${s.name || "(unnamed)"}${s.contractor ? ` · ${s.contractor}` : ""}` : "No service";
  };

  /** Options grouped by service when the list spans more than one service. */
  const grouped = (items: { value: string; label: string; sid: string | null }[]) => {
    const order: (string | null)[] = [];
    const by = new Map<string | null, typeof items>();
    for (const it of items) {
      if (!by.has(it.sid)) {
        by.set(it.sid, []);
        order.push(it.sid);
      }
      by.get(it.sid)!.push(it);
    }
    const opt = (it: (typeof items)[number]) => <option key={it.value} value={it.value}>{it.label}</option>;
    if (order.length <= 1) return items.map(opt);
    return order.map((sid) => <optgroup key={sid ?? "none"} label={svcName(sid)}>{by.get(sid)!.map(opt)}</optgroup>);
  };
  const deviceOptions = (current: string, exclude: string[]) => {
    const list = devices.filter((d) => d.id === current || (devOk(d) && !exclude.includes(d.id)));
    return (
      <>
        <option value="">— select a device ({list.filter((d) => d.id !== current).length}) —</option>
        {grouped(list.map((d) => ({ value: d.id, label: devLabel(d), sid: devSvc(d) })))}
      </>
    );
  };
  const hopOptions = (current?: PathHop) => {
    const cur = current ? `${current.kind}:${current.id}` : "";
    const items: { value: string; label: string; sid: string | null; key: number[] }[] = [];
    // Firewalls first within each service, then devices, following the network order.
    for (const f of firewalls) if (cur === `firewall:${f.id}` || fwCand(f)) items.push({ value: `firewall:${f.id}`, label: fwLabel(f), sid: f.serviceId, key: [0] });
    for (const d of devices) {
      if (cur !== `device:${d.id}` && (!devOk(d) || d.id === fromId || d.id === toId)) continue;
      items.push({ value: `device:${d.id}`, label: devLabel(d), sid: devSvc(d), key: [1] });
    }
    const sOrder = new Map(services.map((s, i) => [s.id as string | null, i]));
    items.sort((a, b) => (sOrder.get(a.sid) ?? 1e9) - (sOrder.get(b.sid) ?? 1e9) || a.key[0] - b.key[0]);
    if (current && !items.some((i) => i.value === cur)) items.unshift({ value: cur, label: "? (deleted)", sid: null, key: [0] });
    return (
      <>
        {!current && <option value="">— add a firewall or device ({items.length}) —</option>}
        {!current && <option value="custom:">✎ Custom network trajectory (free text)…</option>}
        {grouped(items)}
      </>
    );
  };

  /** IP / VLAN / firewall / service / category of the chosen element, as defined in Network. */
  const Info = ({ kind, id }: { kind: PathHop["kind"]; id: string }) => {
    if (!id || kind === "custom") return null;
    if (kind === "firewall") {
      const f = fwm.get(id);
      if (!f) return <div className="einfo err-t">Firewall no longer exists</div>;
      return (
        <div className="einfo">
          {f.mgmtIp && <span className="mono">{f.mgmtIp}</span>}
          {f.vendorModel && <span>{f.vendorModel}</span>}
          <span>{svcName(f.serviceId)}</span>
        </div>
      );
    }
    const d = dev.get(id);
    if (!d) return <div className="einfo err-t">Device no longer exists</div>;
    const { vlan, firewall, service } = chainOf(d, h);
    const c = d.categoryId ? cmap.get(d.categoryId) : undefined;
    const off = inactiveReason(d, h);
    return (
      <div className="einfo">
        <span className="mono">{d.ip || "no IP"}</span>
        <span>{vlan ? <>VLAN {vlan.vlan}{vlan.name ? ` ${vlan.name}` : ""} <span className="mono">{vlan.subnet}</span>{vlan.gateway ? <> gw <span className="mono">{vlan.gateway}</span></> : null}</> : "no VLAN"}</span>
        {firewall && <span>FW {firewall.name}</span>}
        <span>{service ? service.name : "No service"}</span>
        {c && <span className="ecat"><i className="catdot" style={{ background: c.color }} />{c.name}</span>}
        {d.type && <span>{d.type}</span>}
        {off && <span className="err-t">inactive: {off}</span>}
      </div>
    );
  };

  const parse = (v: string): { kind: PathHop["kind"]; id: string } | null => {
    const [k, id] = v.split(":");
    if (k === "custom") return { kind: "custom", id: "" };
    return k && id ? { kind: k as PathHop["kind"], id } : null;
  };
  const setHop = (i: number, p: Partial<PathHop>) => setHops(hops.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const moveHop = (i: number, to: number) => {
    if (to < 0 || to >= hops.length) return;
    const o = hops.slice();
    const [m] = o.splice(i, 1);
    o.splice(to, 0, m);
    setHops(o);
  };
  const addHop = (v: string) => {
    const p = parse(v);
    if (!p) return;
    setHops([...hops, { ...p, inPort: "", outPort: "", ...(p.kind === "custom" ? { label: "" } : {}) }]);
    setPick("");
  };
  const swap = () => {
    setFromId(toId);
    setToId(fromId);
    setClientPort(serverPort);
    setServerPort(clientPort);
    setClientIp(serverIp);
    setServerIp(clientIp);
    setClientVlanId(serverVlanId);
    setServerVlanId(clientVlanId);
    setHops(hops.slice().reverse().map((x) => ({ ...x, inPort: x.single ? x.inPort : x.outPort, outPort: x.single ? x.outPort : x.inPort })));
  };

  const draft: Connection = {
    id: conn?.id ?? "", fromId: fromId || null, toId: toId || null, protocolId: protocolId || null, port: "", address: "", sourceId: null, topic: "",
    bidirectional: false, notes: "", clientPort, serverPort, path: hops,
  };
  /** Turning per-end VLAN / IP on starts from the devices' own IP and VLAN. */
  const toggleEndNet = (on: boolean) => {
    setEndNet(on);
    if (!on) return;
    const f = dev.get(fromId);
    const t = dev.get(toId);
    if (!clientIp && f) setClientIp(f.ip);
    if (!clientVlanId && f?.vlanId) setClientVlanId(f.vlanId);
    if (!serverIp && t) setServerIp(t.ip);
    if (!serverVlanId && t?.vlanId) setServerVlanId(t.vlanId);
  };
  const vlanText = (v: Vlan) => {
    const f = fwm.get(v.firewallId ?? "");
    return `VLAN ${v.vlan}${v.name ? ` ${v.name}` : ""} · ${v.subnet || "no subnet"}${f ? ` · ${f.name}` : ""}`;
  };
  const vlanOptions = (current: string) => (
    <>
      <option value="">— VLAN —</option>
      {grouped(vlans.map((v) => ({ value: v.id, label: vlanText(v), sid: fwm.get(v.firewallId ?? "")?.serviceId ?? null })))}
      {current && !vl.has(current) && <option value={current}>? (deleted)</option>}
    </>
  );
  const endNetRow = (end: "client" | "server") => {
    if (!endNet) return null;
    const [ip, setIp, vid, setVid] = end === "client" ? [clientIp, setClientIp, clientVlanId, setClientVlanId] : [serverIp, setServerIp, serverVlanId, setServerVlanId];
    const v = vid ? vl.get(vid) : undefined;
    const n = ip.trim() ? parseIp(ip) : null;
    const c = v ? parseCidr(v.subnet) : null;
    const warn = ip.trim() && n == null ? "Not a valid IPv4 address" : n != null && c && !inCidr(c, n) ? `Outside ${v!.subnet}` : "";
    return (
      <div className="hrow endnet">
        <span className="badge" style={{ background: "transparent" }} />
        <select aria-label={`${end === "client" ? "Client" : "Server"} VLAN`} value={vid} onChange={(e) => setVid(e.target.value)}>{vlanOptions(vid)}</select>
        <label>IP <input type="text" className="mono" aria-label={`${end === "client" ? "Client" : "Server"} IP`} value={ip} onChange={(e) => setIp(e.target.value)} /></label>
        {warn && <span className="chip">{warn}</span>}
      </div>
    );
  };
  const problems = [
    !fromId && "No client (From) device",
    !toId && "No server (To) device",
    fromId && fromId === toId && "Client and server are the same device",
    !protocolId && "No protocol",
  ].filter(Boolean) as string[];

  const save = async () => {
    setBusy(true);
    const body: Partial<Connection> = {
      fromId: fromId || null, toId: toId || null, protocolId: protocolId || null,
      clientPort: clientPort.trim(), serverPort: serverPort.trim(),
      path: hops.map((x) => ({ ...x, inPort: x.inPort.trim(), outPort: x.single ? "" : x.outPort.trim(), ...(x.kind === "custom" ? { label: (x.label ?? "").trim() } : {}) })),
      endNet, clientIp: clientIp.trim(), clientVlanId: clientVlanId || null, serverIp: serverIp.trim(), serverVlanId: serverVlanId || null,
    };
    try {
      const r = conn ? await api.connections.update(conn.id, body) : await api.connections.create({ ...defaults, ...body });
      onSaved(r, !conn);
      onClose();
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const bubbles = (k: Filter, title: string, items: { id: string; label: string; hint?: string; color?: string }[], extra?: React.ReactNode) => (
    <div className="bubbles" role="group" aria-label={`Filter by ${title}`}>
      <span className="muted lbl">{title}</span>
      <button type="button" className="bubble" aria-pressed={!sel[k].length} onClick={() => toggle(k, null)}>All</button>
      {items.map((x) => (
        <button key={x.id} type="button" className="bubble" aria-pressed={sel[k].includes(x.id)} title={x.hint} onClick={() => toggle(k, x.id)}>
          {x.color && <i style={{ background: x.color }} />}
          {x.label}
        </button>
      ))}
      {extra}
    </div>
  );

  const ordered = orderedProtocols(protocols);
  return (
    <Modal onClose={onClose} label="Connection">
      <div className="mh">
        <h3>{conn ? "Connection" : "New connection"}{fromId || toId ? ` — ${nameOf("device", fromId || null)} → ${nameOf("device", toId || null)}` : ""}</h3>
        <span className="grow" />
        <label className="f-inline">
          Protocol
          <select aria-label="Protocol" value={protocolId} onChange={(e) => setProtocolId(e.target.value)}>
            <option value="">— select —</option>
            {ordered.map((p) => <option key={p.id} value={p.id}>{`${"  ".repeat(p.depth)}${p.name}${p.dfAlias ? ` (${p.dfAlias})` : ""}`}</option>)}
          </select>
        </label>
      </div>
      <div className="mb pathed">
        <div className="filters">
          {bubbles("service", "Service", services.map((s) => ({ id: s.id, label: s.name || "(unnamed)", hint: `${s.kind}${s.contractor ? ` · ${s.contractor}` : ""}` })))}
          {bubbles("category", "Category", [...cats.map((c) => ({ id: c.id, label: c.name, color: c.color })), { id: "none", label: "None" }])}
          {bubbles("firewall", "Firewall", firewalls.filter((f) => fwOk(f.id)).map((f) => ({ id: f.id, label: f.name || "(unnamed)" })))}
          {bubbles("vlan", "VLAN", vlans.filter((v) => vlanOk(v.id)).map((v) => ({ id: v.id, label: `${v.vlan}${v.name ? ` ${v.name}` : ""}`, hint: v.subnet })))}
        </div>
        <label className="chk-l endnet-toggle" title="A device can reach different segments through different ports: set the VLAN and IP used by this connection at each end">
          <input type="checkbox" checked={endNet} onChange={(e) => toggleEndNet(e.target.checked)} /> Define VLAN / IP per end for this connection
        </label>
        <ol className="hops">
          <li className="end">
            <div className="hrow">
              <span className="badge b-device">FROM</span>
              <select aria-label="Client (From) device" value={fromId} onChange={(e) => setFromId(e.target.value)}>{deviceOptions(fromId, [toId])}</select>
              <label>Port <input type="text" className="mono" aria-label="Client port" value={clientPort} onChange={(e) => setClientPort(e.target.value)} /></label>
              <span className="ctl"><button type="button" className="btn-ghost" title="Swap client and server (reverses the path)" aria-label="Swap client and server" onClick={swap}>⇅</button></span>
            </div>
            {endNetRow("client")}
            <Info kind="device" id={fromId} />
            <div className="role muted">client / master / publisher</div>
          </li>
          {hops.map((hp, i) => (
            <li key={i}>
              <div className="hrow">
                <span className={`badge b-${hp.kind}`}>{i + 1}</span>
                {hp.kind === "custom" ? (
                  <input
                    type="text"
                    className="custom-hop"
                    aria-label={`Hop ${i + 1} custom trajectory`}
                    placeholder="Custom network trajectory — name or description"
                    value={hp.label ?? ""}
                    onChange={(e) => setHop(i, { label: e.target.value })}
                  />
                ) : (
                  <select aria-label={`Hop ${i + 1}`} value={`${hp.kind}:${hp.id}`} onChange={(e) => { const p = parse(e.target.value); if (p) setHop(i, p.kind === "custom" ? { ...p, label: "" } : p); }}>
                    {hopOptions(hp)}
                  </select>
                )}
                <Seg label={`Hop ${i + 1} ports`} value={hp.single ? "in" : "inout"} options={[["in", "In only"], ["inout", "In / Out"]]} onChange={(v) => setHop(i, { single: v === "in" })} />
                <label>{hp.single ? "Port" : "In"} <input type="text" className="mono" value={hp.inPort} aria-label={`Hop ${i + 1} in port`} onChange={(e) => setHop(i, { inPort: e.target.value })} /></label>
                {!hp.single && <label>Out <input type="text" className="mono" value={hp.outPort} aria-label={`Hop ${i + 1} out port`} onChange={(e) => setHop(i, { outPort: e.target.value })} /></label>}
                <span className="ctl">
                  <button type="button" className="btn-ghost" aria-label="Move hop up" disabled={i === 0} onClick={() => moveHop(i, i - 1)}>↑</button>
                  <button type="button" className="btn-ghost" aria-label="Move hop down" disabled={i === hops.length - 1} onClick={() => moveHop(i, i + 1)}>↓</button>
                  <button type="button" className="btn-ghost btn-danger" aria-label="Remove hop" onClick={() => setHops(hops.filter((_, j) => j !== i))}>✕</button>
                </span>
              </div>
              <Info kind={hp.kind} id={hp.id} />
            </li>
          ))}
          <li className="add">
            <div className="hrow">
              <span className="badge" style={{ background: "var(--line-strong)" }}>+</span>
              <select aria-label="Next hop" value={pick} onChange={(e) => setPick(e.target.value)}>{hopOptions()}</select>
              <button type="button" disabled={!pick} onClick={() => addHop(pick)}>Add hop</button>
            </div>
          </li>
          <li className="end">
            <div className="hrow">
              <span className="badge b-device">TO</span>
              <select aria-label="Server (To) device" value={toId} onChange={(e) => setToId(e.target.value)}>{deviceOptions(toId, [fromId])}</select>
              <label>Port <input type="text" className="mono" aria-label="Server port" value={serverPort} onChange={(e) => setServerPort(e.target.value)} /></label>
            </div>
            {endNetRow("server")}
            <Info kind="device" id={toId} />
            <div className="role muted">server / outstation / broker</div>
          </li>
        </ol>
        <div className="preview" aria-label="Path preview">
          <span className="muted">Path</span>
          <code>{pathText(draft, nameOf)}</code>
        </div>
        {problems.length > 0 && (
          <div className="probs">{problems.map((p) => <Fragment key={p}><span className="chip">{p}</span> </Fragment>)}</div>
        )}
      </div>
      <div className="mf">
        <button type="button" className="btn-danger" disabled={!hops.length} onClick={() => setHops([])} style={{ marginRight: "auto" }}>Clear hops</button>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{conn ? "Save connection" : "Create connection"}</button>
      </div>
    </Modal>
  );
}
