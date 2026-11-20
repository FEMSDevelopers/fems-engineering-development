import { inactiveReason, plainLine, protocolLabel, toTSV, validateDevices, validateVlans, type Connection, type Device, type Firewall, type Grid, type ProtocolDef, type Service, type Vlan } from "@fpl/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { copyText, LineView, Seg, useLocal, useUi } from "../ui";

type Tab = "points" | "configs" | "ipschema";
const PREVIEW = 500;

export function OutputsView({ active }: { active: boolean }) {
  const ui = useUi();
  const [pref, setPref] = useLocal<{ tab: Tab; device: string }>("fpl.out", { tab: "points", device: "" });
  const { tab, device } = pref;
  const [devices, setDevices] = useState<Device[]>([]);
  const [vlans, setVlans] = useState<Vlan[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [firewalls, setFirewalls] = useState<Firewall[]>([]);
  const [conns, setConns] = useState<Connection[]>([]);
  const [protocols, setProtocols] = useState<ProtocolDef[]>([]);
  const [points, setPoints] = useState<{ grid: Grid; notes: string[] } | null>(null);
  const [cfg, setCfg] = useState<{ text: string; notes: string[] } | null>(null);
  const [ip, setIp] = useState<Awaited<ReturnType<typeof api.outputs.ipschema>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [d, v, c, p, sv, fw] = await Promise.all([api.devices.list(), api.vlans.list(), api.connections.list(), api.protocols.list(), api.services.list(), api.firewalls.list()]);
      setServices(sv);
      setFirewalls(fw);
      setDevices(d);
      setVlans(v);
      setConns(c);
      setProtocols(p);
      if (tab === "points") setPoints(await api.outputs.pointlist());
      if (tab === "configs") setCfg(await api.outputs.configs(device || undefined));
      if (tab === "ipschema") setIp(await api.outputs.ipschema());
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [tab, device]);
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const netIssues = useMemo(() => {
    const all = [...Object.values(validateVlans(vlans, firewalls)), ...Object.values(validateDevices(devices, vlans, firewalls))].flat();
    return { err: all.filter((i) => i.level === "error").length, warn: all.filter((i) => i.level === "warn").length };
  }, [devices, vlans, firewalls]);
  const cfgLines = useMemo(() => (cfg ? cfg.text.split("\n").map(plainLine) : []), [cfg]);
  const dname = (id: string | null) => devices.find((x) => x.id === id)?.name || "?";
  // Outputs leave out anything inactive (service → firewall → VLAN → device).
  const h = { services, firewalls, vlans, devices };
  const isOff = (id: string | null) => {
    const d = devices.find((x) => x.id === id);
    return !!d && !!inactiveReason(d, h);
  };
  const linked = conns.filter((c) => c.sourceId && c.toId && !isOff(c.fromId) && !isOff(c.toId));
  const connLabel = (c: Connection) => `${dname(c.toId)} ← ${dname(c.fromId)} · ${protocolLabel(protocols.find((p) => p.id === c.protocolId))}`;

  const copy = async () => {
    const t = tab === "points" ? (points ? toTSV(points.grid) : "") : tab === "configs" ? cfg?.text ?? "" : ip?.markdown ?? "";
    ui.toast((await copyText(t)) ? (tab === "points" ? "Point list copied (pastes into Excel)" : tab === "configs" ? "Config copied" : "IP schema copied as Markdown") : "Copy blocked");
  };
  const dl = (path: string) => {
    const a = document.createElement("a");
    a.href = path;
    a.click();
  };

  return (
    <section className="view simple" aria-label="Outputs">
      <header className="toolbar">
        <h1>Outputs</h1>
        <Seg label="Output" value={tab} options={[["points", "Customer point list"], ["configs", "Source → MQTT configs"], ["ipschema", "IP schema"]]} onChange={(t) => setPref({ ...pref, tab: t })} />
        {tab === "configs" && (
          <select aria-label="Connection" value={device} onChange={(e) => setPref({ ...pref, device: e.target.value })}>
            <option value="">All point-list connections (one file)</option>
            {linked.map((c) => <option key={c.id} value={c.id}>{connLabel(c)}</option>)}
          </select>
        )}
        {(netIssues.err > 0 || netIssues.warn > 0) && (
          <span className={`chip${netIssues.err ? " err" : ""}`} title="See the Network module for details">
            Network checks: {netIssues.err} errors, {netIssues.warn} warnings
          </span>
        )}
        <span className="grow" />
        <button type="button" disabled={busy} onClick={load}>{busy ? "Generating…" : "Regenerate"}</button>
        <button type="button" onClick={copy}>Copy</button>
        {tab === "points" && (
          <>
            <button type="button" onClick={() => dl("/api/outputs/pointlist?format=csv")}>Download CSV</button>
            <button type="button" className="btn-primary" onClick={() => dl("/api/outputs/pointlist?format=xlsx")}>Download XLSX</button>
          </>
        )}
        {tab === "configs" && <button type="button" className="btn-primary" onClick={() => dl(`/api/outputs/configs?format=file${device ? `&connectionId=${device}` : ""}`)}>Download JSON</button>}
        {tab === "ipschema" && (
          <>
            <button type="button" onClick={() => dl("/api/outputs/ipschema?format=md")}>Download Markdown</button>
            <button type="button" onClick={() => dl("/api/outputs/ipschema?format=csv")}>CSV</button>
            <button type="button" className="btn-primary" onClick={() => dl("/api/outputs/ipschema?format=xlsx")}>XLSX</button>
          </>
        )}
      </header>
      <section className="pane">
        <div className="scroll">
          {err ? (
            <div className="empty-state"><h3>Couldn’t generate this output</h3><p>{err}</p></div>
          ) : tab === "points" ? (
            !points ? null : points.grid.length < 2 ? (
              <div className="empty-state"><h3>No points yet</h3><p>Link connections to point-list sources in Data flow → Connection list.</p></div>
            ) : (
              <div className="outbody">
                <span className="muted">{points.grid.length - 1} points across {new Set(points.grid.slice(1).map((r) => r[0])).size} devices{points.grid.length - 1 > PREVIEW ? ` · showing first ${PREVIEW}` : ""}</span>
                {points.notes.length > 0 && <ul className="notes">{points.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                <div style={{ overflow: "auto" }}>
                  <table className="grid">
                    <thead><tr>{points.grid[0].map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                    <tbody>
                      {points.grid.slice(1, PREVIEW + 1).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={v === "" ? "empty" : undefined}>{v}</td>)}</tr>)}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          ) : tab === "configs" ? (
            !cfg ? null : (
              <div>
                {cfg.notes.length > 0 && <ul className="notes" style={{ padding: "10px 12px 0 30px" }}>{cfg.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                <p className="muted" style={{ margin: "10px 12px 0", fontSize: 12.5 }}>
                  One config per connection that carries a point list. Each point is the source row with that source's latest editor profile applied (rules, key order, literals), plus mqtt_topic = connection MQTT topic / tag.
                </p>
                <pre className="json">{cfgLines.map((l, i) => <LineView key={i} line={l} />)}</pre>
              </div>
            )
          ) : !ip ? null : (
            <div className="outbody">
              {ip.sections.length === 0 && <div className="empty-state"><h3>No VLANs or devices yet</h3><p>Add them in the Network module.</p></div>}
              {ip.sections.map((s, i) => (
                <div key={i} className="ipsec">
                  <h3>
                    {[s.service && `${s.service.name}${s.service.contractor ? ` (${s.service.contractor})` : ""}`, s.firewall?.name].filter(Boolean).map((x) => <span key={x as string} className="muted">{x} › </span>)}
                    {s.vlan ? `VLAN ${s.vlan.vlan} — ${s.vlan.name || "(unnamed)"}` : "Unassigned devices"}
                  </h3>
                  {s.vlan && <div className="sub">subnet {s.vlan.subnet || "—"} · mask {s.mask || "—"} · gateway {s.vlan.gateway || "—"}{s.vlan.notes ? ` · ${s.vlan.notes}` : ""}</div>}
                  {s.devices.length ? (
                    <table className="vt" style={{ marginTop: 6 }}>
                      <thead><tr><th>Device</th><th>Type</th><th>Serial number</th><th>IP address</th><th>Protocols</th><th>Notes</th></tr></thead>
                      <tbody>
                        {s.devices.map((d) => (
                          <tr key={d.id}><td>{d.name}</td><td>{d.type}</td><td className="v">{d.serial}</td><td className="v">{d.ip}</td><td>{d.protocols}</td><td>{d.notes}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="muted" style={{ margin: "6px 0 0" }}>No devices.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
