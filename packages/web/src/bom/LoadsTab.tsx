import {
  POWER_KINDS, computeLoads, emptyBus, findNode, itemNumbers, loadGrid, newId, nodeIdentity, powerNodes, walk,
  type BomDoc, type BomNode, type LoadBus, type LoadEntry, type PowerKind,
} from "@fpl/core";
import { useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { Modal, useLocal, useUi } from "../ui";
import { NumIn, TextIn, fmtN, type Catalog } from "./shared";

const KIND_LABEL: Record<LoadEntry["kind"], string> = { node: "BOM line", bus: "Downstream bus", loss: "Losses (η)", manual: "Manual" };

/** Load schedules per feeder / DC bus, computed from the BOM's power data (drawing-set layout). */
export function LoadsTab({ cat, doc, setDoc }: { cat: Catalog; doc: BomDoc; setDoc: (d: BomDoc) => void }) {
  const ui = useUi();
  const [selId, setSelId] = useLocal<string | null>("fpl.bom.bus", null);
  const [adding, setAdding] = useState(false);
  const buses = doc.loads ?? [];
  const bus = buses.find((b) => b.id === selId) ?? buses[0] ?? null;
  const results = useMemo(() => computeLoads(buses, doc.units, cat.ctx), [buses, doc.units, cat.ctx]);
  const res = bus ? results.get(bus.id) : undefined;
  const nos = useMemo(() => itemNumbers(doc.units), [doc.units]);
  const nodeOpts = useMemo(() => {
    const l: { n: BomNode; label: string }[] = [];
    for (const u of doc.units)
      walk(u.children, (n) => {
        if (n.kind !== "part") return;
        const id = nodeIdentity(n, cat.ctx);
        l.push({ n, label: `${u.tags[0] ?? u.name} · ${nos.get(n.id)} · ${id.partNumber || id.description}${n.tags.length ? ` (${n.tags.join(", ")})` : ""}` });
      });
    return l;
  }, [doc.units, cat.ctx, nos]);
  const sources = nodeOpts.filter((o) => nodeIdentity(o.n, cat.ctx).part?.powerOut);

  const setBuses = (l: LoadBus[]) => setDoc({ ...doc, loads: l });
  const setBus = (patch: Partial<LoadBus>) => bus && setBuses(buses.map((b) => (b.id === bus.id ? { ...b, ...patch } : b)));
  const setEntry = (id: string, patch: Partial<LoadEntry>) => bus && setBus({ entries: bus.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  const addEntry = (e: Partial<LoadEntry>) => bus && setBus({ entries: [...bus.entries, { id: newId(), kind: "manual", label: "", watts: null, ...e } as LoadEntry] });
  const move = (i: number, d: -1 | 1) => {
    if (!bus) return;
    const l = bus.entries.slice();
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    setBus({ entries: l });
  };

  const exportX = async () => {
    const grid: string[][] = [];
    const groupRows: number[] = [];
    for (const b of buses) {
      const r = results.get(b.id);
      if (!r) continue;
      const g = loadGrid(b, r);
      groupRows.push(grid.length, grid.length + 2);
      grid.push(...g, ["", ""]);
    }
    try {
      await api.bomFiles.xlsx(`${doc.project.name || "project"} load schedule`, [{ name: "Load schedule", grid, groupRows }]);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };

  return (
    <div className="loadwrap">
      <section className="pane buslist">
        <div className="pane-head">
          <h3>Buses / feeders</h3>
          <div className="tools">
            <button type="button" className="btn-primary" onClick={() => {
              const b = emptyBus({ title: `LOAD SCHEDULE - ${doc.units[0]?.tags[0] ?? "UNIT"}`, subtitle: "L-N 230VAC, 50HZ, FEEDER #1" });
              setBuses([...buses, b]);
              setSelId(b.id);
            }}>+ Bus</button>
          </div>
        </div>
        <div className="scroll">
          <ul className="srclist">
            {buses.map((b) => {
              const r = results.get(b.id);
              return (
                <li key={b.id}>
                  <button type="button" aria-current={b.id === bus?.id} onClick={() => setSelId(b.id)}>
                    <span className="nm">{b.title}</span>
                    <span className="meta">
                      <span>{b.subtitle}</span>
                      <span>{fmtN(r?.totalW)} W · {fmtN(r?.amps, 2)} A{r?.loadingPct != null ? ` · ${fmtN(r.loadingPct)} %` : ""}</span>
                      {r?.issues.length ? <span className="chip">{r.issues.length} !</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
            {!buses.length && <li className="muted" style={{ padding: 10, fontSize: 12.5 }}>Add a bus for each feeder and DC distribution (e.g. 230 VAC feeder #1, 24 VDC from PS.01/02). A DC bus fed by a power supply is added to its upstream feeder as a “Downstream bus” line, which adds the supply's losses from its efficiency.</li>}
          </ul>
        </div>
        <div className="pane-head"><button type="button" disabled={!buses.length} onClick={exportX}>Export load schedules (.xlsx)</button></div>
      </section>
      {bus && res ? (
        <section className="pane bused">
          <div className="scroll">
            <div className="card">
              <div className="frow tight">
                <label className="f" style={{ flex: 3 }}>Title<TextIn label="Title" value={bus.title} onChange={(v) => setBus({ title: v })} /></label>
                <label className="f" style={{ flex: 2 }}>Subtitle<TextIn label="Subtitle" value={bus.subtitle} onChange={(v) => setBus({ subtitle: v })} /></label>
              </div>
              <div className="frow tight">
                <label className="f">Type<select value={bus.kind} onChange={(e) => setBus({ kind: e.target.value as PowerKind })}>{POWER_KINDS.filter(([k]) => k).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                <label className="f">Voltage (V)<NumIn label="Voltage" value={bus.voltage} onChange={(v) => setBus({ voltage: v })} width={70} /></label>
                {bus.kind !== "DC" && <label className="f">PF<NumIn label="Power factor" value={bus.pf} onChange={(v) => setBus({ pf: v })} width={60} /></label>}
                <label className="f">OCPD factor<NumIn label="OCPD factor" value={bus.ocpdFactor} onChange={(v) => setBus({ ocpdFactor: v })} width={60} /></label>
                <label className="f" style={{ flex: 2 }}>Source device (BOM)
                  <select value={bus.source.nodeId ?? ""} onChange={(e) => {
                    const o = sources.find((x) => x.n.id === e.target.value);
                    const part = o ? nodeIdentity(o.n, cat.ctx).part : undefined;
                    setBus({ source: { ...bus.source, nodeId: o?.n.id ?? null, label: o ? o.n.tags.join("/") || part?.partNumber || "" : bus.source.label, ratingW: part?.powerOut?.watts ?? bus.source.ratingW, ratingA: part?.powerOut?.amps ?? bus.source.ratingA, efficiency: part?.powerOut?.efficiency ?? bus.source.efficiency } });
                  }}>
                    <option value="">— none / manual —</option>
                    {sources.map((o) => <option key={o.n.id} value={o.n.id}>{o.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="frow tight">
                <label className="f">Source label<TextIn label="Source label" value={bus.source.label} placeholder="PS.01/02" onChange={(v) => setBus({ source: { ...bus.source, label: v } })} /></label>
                <label className="f">Rating (W)<NumIn label="Rating W" value={bus.source.ratingW} onChange={(v) => setBus({ source: { ...bus.source, ratingW: v } })} width={80} /></label>
                <label className="f">Rating (A)<NumIn label="Rating A" value={bus.source.ratingA} onChange={(v) => setBus({ source: { ...bus.source, ratingA: v } })} width={70} /></label>
                <label className="f">Efficiency<NumIn label="Efficiency" value={bus.source.efficiency} placeholder="0.92" onChange={(v) => setBus({ source: { ...bus.source, efficiency: v != null && v > 1 ? v / 100 : v } })} width={70} /></label>
                <button type="button" className="btn-danger" style={{ flex: 0, alignSelf: "flex-end" }} onClick={async () => {
                  if (!(await ui.confirm(`Delete bus “${bus.title}”?`, "Delete"))) return;
                  setBuses(buses.filter((b) => b.id !== bus.id).map((b) => ({ ...b, entries: b.entries.filter((e) => e.busId !== bus.id) })));
                }}>Delete bus</button>
              </div>
            </div>
            <div className="card">
              <div className="head">
                <h3>Loads</h3>
                <span className="grow" />
                <button type="button" onClick={() => setAdding(true)}>+ From BOM…</button>
                <button type="button" onClick={() => addEntry({ kind: "bus", label: "" })} disabled={buses.length < 2}>+ Downstream bus</button>
                <button type="button" onClick={() => addEntry({ kind: "loss", label: "REDUNDANCY MODULE LOSS", efficiency: 0.975 })}>+ Losses</button>
                <button type="button" onClick={() => addEntry({ kind: "manual", label: "" })}>+ Manual</button>
              </div>
              <table className="mini wide loads">
                <thead><tr><th>Type</th><th>Item</th><th>Label (description)</th><th>W / unit override</th><th>η</th><th>Factor</th><th>Load (W)</th><th /></tr></thead>
                <tbody>
                  {bus.entries.map((e, i) => {
                    const rows = res.rows.filter((r) => r.entryId === e.id || r.entryId === `${e.id}:loss`);
                    const node = e.nodeId ? findNode(doc.units, e.nodeId)?.node : undefined;
                    return (
                      <tr key={e.id}>
                        <td className="muted">{KIND_LABEL[e.kind]}</td>
                        <td>
                          {e.kind === "node" ? (
                            <span style={{ display: "flex", gap: 4 }}>
                              <select value={e.nodeId ?? ""} aria-label="BOM line" onChange={(ev) => setEntry(e.id, { nodeId: ev.target.value, tag: "" })} style={{ maxWidth: 260 }}>
                                <option value="">—</option>
                                {nodeOpts.map((o) => <option key={o.n.id} value={o.n.id}>{o.label}</option>)}
                              </select>
                              {node && node.tags.length > 1 && (
                                <select value={e.tag ?? ""} aria-label="Unit" onChange={(ev) => setEntry(e.id, { tag: ev.target.value })}>
                                  <option value="">all {node.tags.length}</option>
                                  {node.tags.map((t) => <option key={t}>{t}</option>)}
                                </select>
                              )}
                            </span>
                          ) : e.kind === "bus" ? (
                            <select value={e.busId ?? ""} aria-label="Bus" onChange={(ev) => setEntry(e.id, { busId: ev.target.value })}>
                              <option value="">—</option>
                              {buses.filter((b) => b.id !== bus.id).map((b) => <option key={b.id} value={b.id}>{b.title} · {b.subtitle}</option>)}
                            </select>
                          ) : null}
                        </td>
                        <td><TextIn label="Label" value={e.label} placeholder={rows[0]?.description ?? ""} onChange={(v) => setEntry(e.id, { label: v })} /></td>
                        <td>{e.kind === "node" || e.kind === "manual" ? <NumIn label="Watts" value={e.watts} placeholder={e.kind === "node" ? "from part" : "W"} onChange={(v) => setEntry(e.id, { watts: v })} width={80} /> : null}</td>
                        <td>{e.kind === "loss" ? <NumIn label="Efficiency" value={e.efficiency ?? null} onChange={(v) => setEntry(e.id, { efficiency: v != null && v > 1 ? v / 100 : v })} width={60} /> : null}</td>
                        <td><NumIn label="Factor" value={e.factor ?? null} placeholder="1" onChange={(v) => setEntry(e.id, { factor: v })} width={50} /></td>
                        <td className="num" title={rows.map((r) => r.warn).filter(Boolean).join("\n") || undefined}>
                          {rows.map((r) => <div key={r.entryId}>{fmtN(r.watts)}{r.warn && <span className="chip"> !</span>}</div>)}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button type="button" className="btn-ghost" aria-label="Move up" onClick={() => move(i, -1)}>↑</button>
                          <button type="button" className="btn-ghost" aria-label="Move down" onClick={() => move(i, 1)}>↓</button>
                          <button type="button" className="btn-ghost btn-danger" aria-label="Remove" onClick={() => setBus({ entries: bus.entries.filter((x) => x.id !== e.id) })}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="head"><h3>Schedule</h3>{res.issues.map((x) => <span key={x} className="chip">{x}</span>)}</div>
              <table className="mini loadsheet">
                <tbody>
                  <tr className="t"><td colSpan={2}>{bus.title}</td></tr>
                  <tr className="t2"><td colSpan={2}>{bus.subtitle}</td></tr>
                  <tr className="h"><td>DESCRIPTION</td><td>LOAD (W)</td></tr>
                  {res.rows.map((r) => <tr key={r.entryId}><td>{r.description}</td><td className="num">{fmtN(r.watts, 1)}</td></tr>)}
                  <tr className="sum"><td>TOTAL LOAD</td><td className="num">{fmtN(res.totalW, 1)}</td></tr>
                  <tr className="sum"><td>TOTAL AMPS</td><td className="num">{fmtN(res.amps, 2)}</td></tr>
                  <tr className="sum"><td>OCPD {Math.round((bus.ocpdFactor ?? 1.25) * 100)}%</td><td className="num">{fmtN(res.ocpdA, 2)}</td></tr>
                  {res.loadingPct != null && <tr className="sum"><td>LOADING (%) of {res.rating}</td><td className="num">{fmtN(res.loadingPct, 1)}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : (
        <section className="pane"><div className="empty-state"><h3>No load schedule yet</h3><p>Add a bus, then add BOM lines (their part's input power), downstream buses and losses. Totals, amps, OCPD (125 %) and source loading follow the drawing-set load schedules.</p></div></section>
      )}
      {adding && bus && (
        <AddFromBom
          doc={doc}
          cat={cat}
          already={new Set(bus.entries.map((e) => e.nodeId).filter((x): x is string => !!x))}
          onAdd={(ids) => setBus({ entries: [...bus.entries, ...ids.map((id): LoadEntry => ({ id: newId(), kind: "node", nodeId: id, label: "", watts: null }))] })}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function AddFromBom({ doc, cat, already, onAdd, onClose }: { doc: BomDoc; cat: Catalog; already: Set<string>; onAdd: (ids: string[]) => void; onClose: () => void }) {
  const list = useMemo(() => powerNodes(doc.units, cat.ctx), [doc.units, cat.ctx]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [unit, setUnit] = useState("");
  const units = [...new Set(list.map((x) => x.unit))];
  const shown = list.filter((x) => !unit || x.unit === unit);
  return (
    <Modal onClose={onClose} label="Add loads from the BOM">
      <div className="mh"><h3>Add loads from the BOM</h3><span className="muted" style={{ fontSize: 12.5 }}>Lines whose part has power data in the master list.</span></div>
      <div className="mb">
        <div className="toolbar">
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit"><option value="">All units</option>{units.map((u) => <option key={u}>{u}</option>)}</select>
          <button type="button" className="btn-ghost" onClick={() => setPick(new Set(shown.filter((x) => x.watts != null && !already.has(x.node.id)).map((x) => x.node.id)))}>Select all loads</button>
        </div>
        <table className="mini wide">
          <thead><tr><th /><th>Unit</th><th>Item</th><th>Part</th><th>Tags</th><th>Qty</th><th>Feed</th><th>W / unit</th></tr></thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.node.id} className={already.has(x.node.id) ? "dim" : undefined}>
                <td><input type="checkbox" aria-label="Add" disabled={already.has(x.node.id)} checked={pick.has(x.node.id)} onChange={() => setPick((s) => (s.has(x.node.id) ? (s.delete(x.node.id), new Set(s)) : new Set(s.add(x.node.id))))} /></td>
                <td className="mono">{x.unit}</td><td className="mono">{x.itemNo}</td><td>{x.label}</td><td className="mono">{x.node.tags.join(", ")}</td><td>{x.node.qty}</td>
                <td>{x.kind} {fmtN(x.voltage)}{x.voltage != null ? " V" : ""}</td><td className="num">{x.watts == null ? <span className="muted">source only</span> : fmtN(x.watts)}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="muted">No BOM lines with power data. Fill in “Power feed” on the parts in the master list.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!pick.size} onClick={() => (onAdd([...pick]), onClose())}>Add {pick.size}</button>
      </div>
    </Modal>
  );
}
