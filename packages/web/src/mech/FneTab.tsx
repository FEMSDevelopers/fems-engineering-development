import {
  CONDUIT_PRESETS, DIN_RAIL_H, DUCT_PRESETS, FNE_SIZES, UNKNOWN_H, UNKNOWN_W, conduitKeepOuts, conduitPreset, ductPreset, emptyFne, findNode, fneBoxes, fneCandidates,
  fneIssues, fneShapes, freeZones, itemSize, newId, nodeIdentity, panelOffset, partDims, toDxf, walk, zoneAt,
  type BomNode, type Conduit, type FneLayout, type FneSize,
} from "@fpl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { type Catalog } from "../bom/shared";
import { PartEditor } from "../bom/PartEditor";
import { useUi } from "../ui";
import { DT_MECH, EquipTable, DevicePanel, PartBalloons, placeTags, IssueList, LenIn, LinkBox, NotInLayout, TagBubbles, UnitBom, addFromBom, download, downloadSvg, stOf, tagsOf, updateLinks, useSplit, useViewGate, useViews, useZoom, viewHref, type DescOf, type DevCtx, type Len, type MechDrag, type Ov } from "./common";
import type { Part, TagDisplay } from "@fpl/core";

const PRESET_SCOPE = "mech.fne-sizes";

/** Field network enclosure: back-panel layout with wire ducts, conduits, free zones for DIN assemblies and panel-mounted devices. */
export function FneTab({ unit, setUnit, cat, len, ov, bomUnit = null, display = "both", descOf, dc }: { unit: BomNode; setUnit: (f: (u: BomNode) => BomNode) => void; cat: Catalog; len: Len; ov?: Ov; bomUnit?: BomNode | null; display?: TagDisplay; descOf?: DescOf; dc?: DevCtx }) {
  const split = useSplit("fne", 360);
  const gate = useViewGate();
  const [editPart, setEditPart] = useState<Part | null>(null);
  const ui = useUi();
  const f = unit.fne;
  const setF = (fn: (f: FneLayout) => FneLayout) => setUnit((u) => (u.fne ? { ...u, fne: fn(u.fne) } : u));
  const [sizes, setSizes] = useState<FneSize[]>(FNE_SIZES);
  const [presetIds, setPresetIds] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [side, setSide] = useState<"setup" | "bom">("setup");
  const svg = useRef<SVGSVGElement>(null);
  const zoom = useZoom("fne", 0.6);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const loadSizes = () =>
    api.presets.list<FneSize>(PRESET_SCOPE).then((l) => {
      const saved = new Map(l.map((p) => [p.data.key, p.data]));
      setPresetIds(Object.fromEntries(l.map((p) => [p.data.key, p.id])));
      setSizes([...FNE_SIZES.map((s) => saved.get(s.key) ?? s), ...l.map((p) => p.data).filter((s) => !FNE_SIZES.some((x) => x.key === s.key))]);
    }).catch(() => {});
  useEffect(() => {
    loadSizes();
  }, []);

  const cands = useMemo(() => fneCandidates(unit, cat.ctx), [unit, cat.ctx]);
  const parts = useMemo(() => {
    const l: BomNode[] = [];
    walk(unit.children, (n) => n.kind === "part" && l.push(n));
    return l;
  }, [unit]);
  const zones = useMemo(() => (f ? freeZones(f) : []), [f]);
  const boxes = useMemo(() => (f ? fneBoxes(f, unit, cat.ctx) : []), [f, unit, cat.ctx]);
  const issues = useMemo(() => (f ? fneIssues(f, unit, cat.ctx) : []), [f, unit, cat.ctx]);
  const { views } = useViews(useMemo(() => parts.map((n) => n.partId).filter((x): x is string => !!x), [parts]));

  if (!f)
    return (
      <div className="empty-state">
        <h3>No enclosure layout for {unit.tags[0] ? `+${unit.tags[0]}` : unit.name} yet</h3>
        <p>Start from a standard tray layout; enclosure, back panel, wire ducts and conduits stay editable.</p>
        <div className="toolbar">
          {sizes.map((s) => <button key={s.key} type="button" className={s.key === "M" ? "btn-primary" : undefined} onClick={() => setUnit((u) => ({ ...u, fne: autoLink(emptyFne(s), u, cat, s) }))}>{s.label}</button>)}
        </div>
      </div>
    );

  const o = panelOffset(f);
  const pad = 80;
  const W = f.enclosure.w + 2 * pad;
  const H = f.enclosure.h + 2 * pad + 40;
  const pt = (e: { clientX: number; clientY: number }) => {
    const m = svg.current?.getScreenCTM();
    const p = m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : new DOMPoint();
    return { x: p.x - o.x, y: p.y - o.y }; // panel coordinates
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    let d: MechDrag;
    try {
      d = JSON.parse(e.dataTransfer.getData(DT_MECH));
    } catch {
      return;
    }
    const p = pt(e);
    const n = findNode([unit], d.nodeId)?.node;
    if (!n) return;
    if (n.kind === "group") {
      if (!zoneAt(zones, p.x, p.y)) return ui.toast("Drop assemblies into a free zone (dashed)");
      const id = newId();
      setF((x) => ({ ...x, zones: [...x.zones, { id, nodeId: n.id, inst: d.inst, px: p.x, py: p.y, offX: 0, offY: 0, clrX: 10, clrY: 10, clrZ: 25 }] }));
      setSel(id);
    } else {
      const s = itemSize(n, cat.ctx);
      const id = newId();
      setF((x) => ({ ...x, items: [...x.items, { id, nodeId: n.id, inst: d.inst, x: Math.round(p.x - (s.w ?? UNKNOWN_W * 3) / 2), y: Math.round(p.y - (s.h ?? UNKNOWN_H) / 2) }] }));
      setSel(id);
    }
  };
  const onDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    setSel(id);
    const b = boxes.find((x) => x.id === id);
    if (!b) return;
    const p = pt(e);
    drag.current = { id, dx: p.x - b.x, dy: p.y - b.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = pt(e);
    setF((x) => {
      const it = x.items.find((i) => i.id === d.id);
      if (it) return { ...x, items: x.items.map((i) => (i.id === d.id ? { ...i, x: Math.round((p.x - d.dx) / 5) * 5, y: Math.round((p.y - d.dy) / 5) * 5 } : i)) };
      // Zone placements: dragging moves the anchor (another zone) — offsets are edited in the panel on the right.
      return { ...x, zones: x.zones.map((z) => (z.id === d.id ? { ...z, px: p.x, py: p.y } : z)) };
    });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const z = f.zones.find((x) => x.id === d.id);
    if (z && !zoneAt(zones, z.px, z.py)) ui.toast("Dropped outside a free zone — move it into a dashed zone");
  };

  const selZone = f.zones.find((z) => z.id === sel);
  const selItem = f.items.find((i) => i.id === sel);
  const selBox = boxes.find((b) => b.id === sel);
  const selNode = selBox ? findNode([unit], selBox.nodeId)?.node : undefined;
  const placed = (n: BomNode) => new Set([...f.zones, ...f.items].filter((x) => x.nodeId === n.id).map((x) => x.inst));
  const setConduit = (id: string, patch: Partial<Conduit>) => setF((x) => ({ ...x, conduits: x.conduits.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const applySize = (s: FneSize) => setF((x) => ({ ...autoLink({ ...x, size: s.key, enclosure: { ...s.enclosure }, panel: { ...s.panel }, ducts: ductPreset(x.ductPreset, s.panel, x.ductW), conduits: conduitPreset(x.conduitPreset, s.enclosure) }, unit, cat, s) }));
  const encOpts = parts.map((n) => ({ n, id: nodeIdentity(n, cat.ctx) }));

  const drawAsm = (b: (typeof boxes)[number]) => {
    const n = findNode([unit], b.nodeId)?.node;
    const l = n?.layout;
    if (!l) return null;
    return (
      <g transform={`translate(${b.x} ${b.y})`} pointerEvents="none">
        {l.rails.map((r) => <rect key={r.id} x={r.x} y={r.y - DIN_RAIL_H / 2} width={r.length} height={DIN_RAIL_H} className="dinrail" />)}
        {l.items.map((it) => {
          const c = findNode([n], it.nodeId)?.node;
          const s = itemSize(c, cat.ctx);
          const w = s.w ?? UNKNOWN_W;
          const h = s.h ?? UNKNOWN_H;
          const rail = l.rails.find((r) => r.id === it.railId);
          const y = rail ? rail.y - h / 2 : it.y;
          const v = c?.partId ? gate(cat.pmap.get(c.partId), views.get(c.partId)?.front) : undefined;
          return viewHref(v) ? <image key={it.id} href={viewHref(v)} x={it.x} y={y} width={w} height={h} preserveAspectRatio="none" /> : <rect key={it.id} x={it.x} y={y} width={w} height={h} className="box inner" />;
        })}
      </g>
    );
  };

  return (
    <div className="mechwrap" style={{ gridTemplateColumns: split.cols }}>
      <section className="pane mpal">
        {split.handle}
        <div className="pane-head"><h3>DIN-rail assemblies</h3><span className="muted">drop into a zone</span></div>
        <div className="scroll" style={{ maxHeight: "40%" }}>
          <EquipTable
            rows={cands.asm.map((n) => {
              const total = Math.max(1, Math.round(n.qty || 1));
              const sz = itemSize(n, cat.ctx);
              return { n, total, left: Array.from({ length: total }, (_, i) => i).filter((i) => !placed(n).has(i)), size: sz.w ? `${len.fmt(sz.w)}×${len.fmt(sz.h)}` : undefined };
            })}
            cat={cat} ov={ov} sel={selNode?.id}
            onDragStart={(n, inst) => (e) => e.dataTransfer.setData(DT_MECH, JSON.stringify({ t: "node", nodeId: n.id, inst } satisfies MechDrag))}
            empty={<>No assemblies with a layout in this FNE. Lay out its DIN-rail groups in the Assemblies tab (source: this layout).</>}
          />
        </div>
        <div className="pane-head"><h3>Panel-mounted devices</h3><span className="muted">heater, UPS battery…</span></div>
        <div className="scroll">
          <EquipTable
            rows={cands.loose.filter((n) => n.id !== f.enclosureNodeId && n.id !== f.panelNodeId).map((n) => {
              const total = Math.max(0, Math.round(n.qty || 0));
              const dd = partDims(nodeIdentity(n, cat.ctx).part);
              return { n, total, left: Array.from({ length: total }, (_, i) => i).filter((i) => !placed(n).has(i)), size: dd.x ? `${len.fmt(dd.x)}×${len.fmt(dd.y)}` : "size?" };
            })}
            cat={cat} ov={ov} sel={selNode?.id}
            onDragStart={(n, inst) => (e) => e.dataTransfer.setData(DT_MECH, JSON.stringify({ t: "node", nodeId: n.id, inst } satisfies MechDrag))}
          />
        </div>
        <NotInLayout ov={ov} cat={cat} onAdd={(b, q) => setUnit((u) => addFromBom(u, b, q))} />
      </section>
      <section className="pane mcanvas">
        <div className="toolbar sub">
          <span className="muted" style={{ fontSize: 12.5 }}>Enclosure {len.fmt(f.enclosure.w)} × {len.fmt(f.enclosure.h)} × {len.fmt(f.enclosure.d)} · panel {len.fmt(f.panel.w)} × {len.fmt(f.panel.h)} · depth available {len.fmt(f.enclosure.d - f.backMm)} · {zones.length} free zones</span>
          <span className="grow" />
          {zoom.controls(W, H)}
          <button type="button" onClick={() => downloadSvg(svg.current, `${unit.tags[0] ?? "FNE"} back panel.svg`)}>SVG</button>
          <button type="button" onClick={() => download(`${unit.tags[0] ?? "FNE"} back panel.dxf`, toDxf(fneShapes(f, unit, cat.ctx)), "application/dxf")}>DXF</button>
        </div>
        <div className="scroll canvasbox" ref={zoom.wrap} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <svg ref={svg} viewBox={`${-pad} ${-pad} ${W} ${H}`} width={W * zoom.z} height={H * zoom.z} className="mechsvg" onPointerMove={onMove} onPointerUp={onUp} onPointerDown={() => setSel(null)}>
            <rect x={0} y={0} width={f.enclosure.w} height={f.enclosure.h} className="enclosure" />
            <g transform={`translate(${o.x} ${o.y})`}>
              <rect x={0} y={0} width={f.panel.w} height={f.panel.h} className="plate" />
              {zones.map((z, i) => (
                <g key={i} data-ui>
                  <rect x={z.x + 3} y={z.y + 3} width={z.w - 6} height={z.h - 6} className="zone" />
                  <text x={z.x + 8} y={z.y + 18} className="unum" textAnchor="start">{`Z${i + 1}  ${len.fmt(z.w)} × ${len.fmt(z.h)}`}</text>
                </g>
              ))}
              {f.ducts.map((d) => <rect key={d.id} x={d.x} y={d.y} width={d.w} height={d.h} className="duct" />)}
              {conduitKeepOuts(f).map((k, i) => <rect key={i} x={k.x} y={k.y} width={k.w} height={k.h} className="keepout" />)}
              {boxes.map((b) => {
                const n = findNode([unit], b.nodeId)?.node;
                const v = b.kind === "item" && n?.partId ? gate(cat.pmap.get(n.partId), views.get(n.partId)?.front) : undefined;
                const bad = issues.some((i) => i.id === b.id && i.level === "error");
                const zp = f.zones.find((z) => z.id === b.id);
                return (
                  <g key={b.id} className={`slot${sel === b.id ? " sel" : ""}${bad ? " bad" : ""} st-${n ? stOf(ov, n.id) : "missing"}`} onPointerDown={(e) => onDown(e, b.id)}>
                    {zp && <rect data-ui x={b.x - zp.clrX} y={b.y - zp.clrY} width={b.w + 2 * zp.clrX} height={b.h + 2 * zp.clrY} className="clear" />}
                    <rect x={b.x} y={b.y} width={b.w} height={b.h} className={`box${b.kind === "zone" ? " asm" : ""}`} />
                    {b.kind === "zone" ? drawAsm(b) : viewHref(v) ? <image href={viewHref(v)} x={b.x} y={b.y} width={b.w} height={b.h} preserveAspectRatio="none" /> : null}
                    {n && display !== "tag" && (f.items.find((i) => i.id === b.id) ?? f.zones.find((z) => z.id === b.id))?.showText !== false && (() => {
                      const d = descOf ? descOf(n) : { left: n.kind === "group" ? n.alias || n.name || "assembly" : `${nodeIdentity(n, cat.ctx).manufacturer}  ${nodeIdentity(n, cat.ctx).partNumber}`, right: "" };
                      const fl = (t: string) => t.split("\n").filter(Boolean).join("  ");
                      return (
                        <>
                          <text x={b.x + 2} y={b.y - 4} className="lbl">{fl(d.left)}</text>
                          {d.right.trim() && <text x={b.x + b.w - 2} y={b.y + b.h + 14} textAnchor="end" className="lbl">{fl(d.right)}</text>}
                        </>
                      );
                    })()}
                    {(() => { const pl = f.items.find((i) => i.id === b.id) ?? f.zones.find((z) => z.id === b.id); return <PartBalloons box={b} labels={pl?.labels} dc={dc} size={Math.max(7, Math.min(11, b.h * 0.1))} />; })()}
                    {n && display !== "pn" && <TagBubbles cx={b.x + b.w / 2} cy={b.y + b.h / 2} tags={(() => { const it = f.items.find((i) => i.id === b.id) ?? f.zones.find((z) => z.id === b.id); return it ? placeTags(ov, dc, n, it) : tagsOf(ov, n, b.inst); })()} maxW={Math.max(60, b.w - 8)} size={Math.max(8, Math.min(13, b.h * 0.12))} />}
                  </g>
                );
              })}
            </g>
            {f.conduits.map((c) => {
              const cx = c.side === "left" ? 0 : c.side === "right" ? f.enclosure.w : c.pos;
              const cy = c.side === "top" ? 0 : c.side === "bottom" ? f.enclosure.h : c.pos;
              return (
                <g key={c.id}>
                  <circle cx={cx} cy={cy} r={c.dia / 2} className="conduit" />
                  <text x={cx} y={c.side === "bottom" ? cy + c.dia / 2 + 18 : cy - c.dia / 2 - 6} textAnchor="middle" className="unum">{c.label}</text>
                </g>
              );
            })}
            <text x={0} y={f.enclosure.h + 70} className="cap">{`${unit.tags[0] ?? unit.name} — BACK PANEL LAYOUT (FRONT VIEW, DOOR OPEN)`}</text>
          </svg>
        </div>
      </section>
      <section className="pane minsp">
        {split.rightHandle}
        <div className="tabs">
          <button type="button" className="tab" aria-selected={side === "setup"} onClick={() => setSide("setup")}>Layout</button>
          <button type="button" className="tab" aria-selected={side === "bom"} onClick={() => setSide("bom")}>FNE bill of material</button>
        </div>
        {side === "bom" ? (
          <div className="ubwrap"><UnitBom unit={unit} setUnit={setUnit} cat={cat} focus={selNode?.id} /></div>
        ) : (
          <div className="scroll">
            {selBox && selNode && (
              <div className="inspf selbox">
                <div className="pane-head" style={{ padding: 0, border: 0 }}>
                  <b>{(selItem ?? selZone ? placeTags(ov, dc, selNode, (selItem ?? selZone)!) : tagsOf(ov, selNode, selBox.inst)).join(" ") || (selNode.kind === "group" ? selNode.alias || selNode.name : nodeIdentity(selNode, cat.ctx).partNumber)}</b>
                  <span className="grow" />
                  {selNode.kind === "part" && selNode.partId && cat.pmap.get(selNode.partId) && <button type="button" className="btn-ghost" title="Settings and configuration of this part number" onClick={() => setEditPart(cat.pmap.get(selNode.partId!)!)}>Edit part…</button>}
                </div>
                <span className="muted" style={{ fontSize: 12 }}>{selNode.kind === "part" ? `${nodeIdentity(selNode, cat.ctx).manufacturer} ${nodeIdentity(selNode, cat.ctx).partNumber} · ` : ""}{len.fmt(selBox.w)} × {len.fmt(selBox.h)}{selBox.d != null ? ` × ${len.fmt(selBox.d)} deep` : ""}</span>
                {stOf(ov, selNode.id) !== "ok" && <span className={`stnote st-${stOf(ov, selNode.id)}`}>{stOf(ov, selNode.id) === "missing" ? "Not on the referenced project BOM any more" : `Placed ${ov?.placed.get(selNode.id) ?? 0} of ${ov?.bomQty.get(selNode.id) ?? 0} on the project BOM`}</span>}
                <LinkBox node={selNode} bomUnit={bomUnit} cat={cat} onChange={(l) => setUnit((u) => updateLinks(u, selNode.id, l))} />
                {selZone && (
                  <>
                    <div className="frow tight">
                      <label className="f">Offset x<LenIn len={len} label="Offset x" value={selZone.offX} width={60} onChange={(v) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, offX: v ?? 0 } : z)) }))} /></label>
                      <label className="f">Offset y<LenIn len={len} label="Offset y" value={selZone.offY} width={60} onChange={(v) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, offY: v ?? 0 } : z)) }))} /></label>
                    </div>
                    <div className="frow tight">
                      <label className="f">Clearance x<LenIn len={len} label="Clearance x" value={selZone.clrX} width={55} onChange={(v) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, clrX: v ?? 0 } : z)) }))} /></label>
                      <label className="f">y<LenIn len={len} label="Clearance y" value={selZone.clrY} width={55} onChange={(v) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, clrY: v ?? 0 } : z)) }))} /></label>
                      <label className="f">z<LenIn len={len} label="Clearance z" value={selZone.clrZ} width={55} onChange={(v) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, clrZ: v ?? 0 } : z)) }))} /></label>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>Centred in its zone; drag it to another zone.</span>
                  </>
                )}
                {selItem && (
                  <div className="frow tight">
                    <label className="f">x<LenIn len={len} label="x" value={selItem.x} width={60} onChange={(v) => setF((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, x: v ?? 0 } : i)) }))} /></label>
                    <label className="f">y<LenIn len={len} label="y" value={selItem.y} width={60} onChange={(v) => setF((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, y: v ?? 0 } : i)) }))} /></label>
                    <button type="button" style={{ alignSelf: "flex-end" }} onClick={() => setF((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, rot: i.rot === 90 ? 0 : 90 } : i)) }))}>Rotate 90°</button>
                  </div>
                )}
                {issues.filter((i) => i.id === selBox.id).map((i, k) => <span key={k} className={i.level === "error" ? "errtxt" : "muted"} style={{ fontSize: 12 }}>{i.msg}</span>)}
                {selItem && <DevicePanel ov={ov} dc={dc} node={selNode} place={selItem} cat={cat} bomUnit={bomUnit} onChange={(devs) => setF((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, devs, dev: null, pin: null } : i)) }))}
                  onLabels={(labels) => setF((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, labels } : i)) }))}
                  onShowText={(v) => setF((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, showText: v ? undefined : false } : i)) }))} />}
                {selZone && <DevicePanel ov={ov} dc={dc} node={selNode} place={selZone} cat={cat} bomUnit={bomUnit} onChange={(devs) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, devs } : z)) }))}
                  onLabels={(labels) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, labels } : z)) }))}
                  onShowText={(v) => setF((x) => ({ ...x, zones: x.zones.map((z) => (z.id === selZone.id ? { ...z, showText: v ? undefined : false } : z)) }))} />}
                <button type="button" className="btn-danger" onClick={() => (setF((x) => ({ ...x, zones: x.zones.filter((z) => z.id !== sel), items: x.items.filter((i) => i.id !== sel) })), setSel(null))}>Remove from panel</button>
              </div>
            )}
            <div className="inspf">
              <h3>Enclosure</h3>
              <div className="frow tight">
                <label className="f">Standard size
                  <select value={f.size} onChange={(e) => {
                    const s = sizes.find((x) => x.key === e.target.value);
                    if (s) applySize(s);
                  }}>
                    {sizes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    {!sizes.some((s) => s.key === f.size) && <option value={f.size}>Custom</option>}
                  </select>
                </label>
                <button type="button" style={{ alignSelf: "flex-end" }} title="Save these enclosure and panel sizes as the standard for this size key (shared)" onClick={async () => {
                  const cur = sizes.find((s) => s.key === f.size);
                  const label = await ui.prompt("Standard size name", cur?.label ?? `Custom ${len.fmt(f.enclosure.w)}×${len.fmt(f.enclosure.h)}`);
                  if (!label) return;
                  const encN = f.enclosureNodeId ? findNode([unit], f.enclosureNodeId)?.node : undefined;
                  const panN = f.panelNodeId ? findNode([unit], f.panelNodeId)?.node : undefined;
                  const data: FneSize = { key: cur?.label === label || cur ? f.size : `C${Date.now().toString(36)}`, label, enclosure: { ...f.enclosure }, panel: { ...f.panel }, enclosurePn: encN ? nodeIdentity(encN, cat.ctx).partNumber : cur?.enclosurePn ?? "", panelPn: panN ? nodeIdentity(panN, cat.ctx).partNumber : cur?.panelPn ?? "" };
                  await api.presets.save(PRESET_SCOPE, data.key, data);
                  void presetIds;
                  await loadSizes();
                  ui.toast(`Saved standard size “${label}”`);
                }}>Save as standard…</button>
              </div>
              <div className="frow tight">
                <label className="f">Enclosure part
                  <select value={f.enclosureNodeId ?? ""} onChange={(e) => {
                    const n = parts.find((x) => x.id === e.target.value);
                    const d = partDims(n ? nodeIdentity(n, cat.ctx).part : undefined);
                    setF((x) => ({ ...x, enclosureNodeId: n?.id ?? null, enclosure: { w: d.x ?? x.enclosure.w, h: d.y ?? x.enclosure.h, d: d.z ?? x.enclosure.d } }));
                  }}>
                    <option value="">—</option>
                    {encOpts.map(({ n, id }) => <option key={n.id} value={n.id}>{id.partNumber} · {id.description.slice(0, 40)}</option>)}
                  </select>
                </label>
                <label className="f">Back-panel part
                  <select value={f.panelNodeId ?? ""} onChange={(e) => {
                    const n = parts.find((x) => x.id === e.target.value);
                    const d = partDims(n ? nodeIdentity(n, cat.ctx).part : undefined);
                    setF((x) => ({ ...x, panelNodeId: n?.id ?? null, panel: { w: d.x ?? x.panel.w, h: d.y ?? x.panel.h } }));
                  }}>
                    <option value="">—</option>
                    {encOpts.map(({ n, id }) => <option key={n.id} value={n.id}>{id.partNumber} · {id.description.slice(0, 40)}</option>)}
                  </select>
                </label>
              </div>
              <div className="frow tight">
                <label className="f">Encl. W<LenIn len={len} label="Enclosure width" value={f.enclosure.w} width={60} onChange={(v) => v && setF((x) => ({ ...x, enclosure: { ...x.enclosure, w: v } }))} /></label>
                <label className="f">H<LenIn len={len} label="Enclosure height" value={f.enclosure.h} width={60} onChange={(v) => v && setF((x) => ({ ...x, enclosure: { ...x.enclosure, h: v } }))} /></label>
                <label className="f">D<LenIn len={len} label="Enclosure depth" value={f.enclosure.d} width={60} onChange={(v) => v && setF((x) => ({ ...x, enclosure: { ...x.enclosure, d: v } }))} /></label>
                <label className="f" title="Standoff + panel thickness behind the mounting surface">Behind panel<LenIn len={len} label="Behind panel" value={f.backMm} width={55} onChange={(v) => setF((x) => ({ ...x, backMm: v ?? 0 }))} /></label>
              </div>
              <div className="frow tight">
                <label className="f">Panel W<LenIn len={len} label="Panel width" value={f.panel.w} width={60} onChange={(v) => v && setF((x) => ({ ...x, panel: { ...x.panel, w: v }, ducts: ductPreset(x.ductPreset, { ...x.panel, w: v }, x.ductW) }))} /></label>
                <label className="f">Panel H<LenIn len={len} label="Panel height" value={f.panel.h} width={60} onChange={(v) => v && setF((x) => ({ ...x, panel: { ...x.panel, h: v }, ducts: ductPreset(x.ductPreset, { ...x.panel, h: v }, x.ductW) }))} /></label>
              </div>
              <h3>Wire duct</h3>
              <div className="frow tight">
                <label className="f">Layout
                  <select value={f.ductPreset} onChange={(e) => setF((x) => ({ ...x, ductPreset: e.target.value, ducts: ductPreset(e.target.value, x.panel, x.ductW) }))}>
                    {DUCT_PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    <option value="custom">Custom (edited)</option>
                  </select>
                </label>
                <label className="f">Duct width<LenIn len={len} label="Duct width" value={f.ductW} width={60} onChange={(v) => v && setF((x) => ({ ...x, ductW: v, ducts: ductPreset(x.ductPreset, x.panel, v) }))} /></label>
              </div>
              <details>
                <summary className="muted">Edit ducts ({f.ducts.length})</summary>
                {f.ducts.map((d, i) => (
                  <div key={d.id} className="frow tight">
                    {(["x", "y", "w", "h"] as const).map((k) => (
                      <label key={k} className="f">{k}<LenIn len={len} label={`Duct ${i + 1} ${k}`} value={d[k]} width={52} onChange={(v) => v != null && setF((x) => ({ ...x, ductPreset: "custom", ducts: x.ducts.map((q) => (q.id === d.id ? { ...q, [k]: v } : q)) }))} /></label>
                    ))}
                    <button type="button" className="btn-ghost btn-danger" style={{ alignSelf: "flex-end" }} aria-label="Delete duct" onClick={() => setF((x) => ({ ...x, ductPreset: "custom", ducts: x.ducts.filter((q) => q.id !== d.id) }))}>✕</button>
                  </div>
                ))}
                <button type="button" onClick={() => setF((x) => ({ ...x, ductPreset: "custom", ducts: [...x.ducts, { id: newId(), x: x.ductW, y: x.panel.h / 2 - x.ductW / 2, w: x.panel.w - 2 * x.ductW, h: x.ductW }] }))}>+ Duct</button>
              </details>
              <h3>Conduits</h3>
              <label className="f">Layout
                <select value={f.conduitPreset} onChange={(e) => setF((x) => ({ ...x, conduitPreset: e.target.value, conduits: conduitPreset(e.target.value, x.enclosure) }))}>
                  {CONDUIT_PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  <option value="custom">Custom (edited)</option>
                </select>
              </label>
              {f.conduits.map((c) => (
                <div key={c.id} className="frow tight">
                  <label className="f">Label<input type="text" value={c.label} onChange={(e) => setConduit(c.id, { label: e.target.value })} style={{ width: 80 }} /></label>
                  <label className="f">Side<select value={c.side} onChange={(e) => setConduit(c.id, { side: e.target.value as Conduit["side"] })}><option value="bottom">Bottom</option><option value="top">Top</option><option value="left">Left</option><option value="right">Right</option></select></label>
                  <label className="f">Pos.<LenIn len={len} label="Position" value={c.pos} width={52} onChange={(v) => v != null && setConduit(c.id, { pos: v })} /></label>
                  <label className="f">OD<LenIn len={len} label="Diameter" value={c.dia} width={48} onChange={(v) => v && setConduit(c.id, { dia: v })} /></label>
                  <label className="f" title="Space reserved on the panel from that side">Keep-out<LenIn len={len} label="Keep-out" value={c.keepOut} width={48} onChange={(v) => setConduit(c.id, { keepOut: v ?? 0 })} /></label>
                  <button type="button" className="btn-ghost btn-danger" style={{ alignSelf: "flex-end" }} aria-label="Delete conduit" onClick={() => setF((x) => ({ ...x, conduitPreset: "custom", conduits: x.conduits.filter((q) => q.id !== c.id) }))}>✕</button>
                </div>
              ))}
              <button type="button" onClick={() => setF((x) => ({ ...x, conduitPreset: "custom", conduits: [...x.conduits, { id: newId(), label: "SPARE", side: "bottom", pos: x.enclosure.w / 2, dia: 33.4, keepOut: 0 }] }))}>+ Conduit</button>
              <button type="button" className="btn-danger" onClick={async () => (await ui.confirm("Delete this enclosure layout?", "Delete")) && setUnit((u) => ({ ...u, fne: null }))}>Delete layout</button>
            </div>
            <div className="pane-head"><h3>Checks</h3></div>
            <IssueList issues={issues} onPick={setSel} />
          </div>
        )}
      </section>
      {editPart && <PartEditor part={editPart} subcats={cat.subcats} parts={cat.parts} onSaved={(p) => cat.putPart(p)} onClose={() => setEditPart(null)} />}
    </div>
  );
}

/** Link the enclosure / back-panel lines of the unit by part number (or subcategory), taking their dimensions when known. */
function autoLink(f: FneLayout, unit: BomNode, cat: Catalog, s: FneSize): FneLayout {
  let enc: BomNode | undefined;
  let pan: BomNode | undefined;
  walk(unit.children, (n) => {
    if (n.kind !== "part") return;
    const id = nodeIdentity(n, cat.ctx);
    const sub = id.part?.subcategoryId ? cat.smap.get(id.part.subcategoryId)?.name ?? "" : "";
    if (!enc && (id.partNumber === s.enclosurePn || (/enclosure/i.test(sub) && /ENCLOSURE/i.test(id.description)))) enc = n;
    else if (!pan && (id.partNumber === s.panelPn || /back panel/i.test(sub) || /CONCEPT PANEL|BACK ?PANEL/i.test(id.description))) pan = n;
  });
  const ed = partDims(enc ? nodeIdentity(enc, cat.ctx).part : undefined);
  const pd = partDims(pan ? nodeIdentity(pan, cat.ctx).part : undefined);
  const panel = { w: pd.x ?? f.panel.w, h: pd.y ?? f.panel.h };
  return {
    ...f, enclosureNodeId: enc?.id ?? null, panelNodeId: pan?.id ?? null,
    enclosure: { w: ed.x ?? f.enclosure.w, h: ed.y ?? f.enclosure.h, d: ed.z ?? f.enclosure.d },
    panel, ducts: ductPreset(f.ductPreset, panel, f.ductW),
  };
}
