import {
  ASM_MOUNTS, DIN_RAIL_H, PALETTE_COLORS, U_MM, UNKNOWN_H, UNKNOWN_W, applyArray, arrayMembers, asmIssues, asmShapes, autoArrange, emptyAsmLayout, findNode, hasRear, itemPad, itemSize, newId,
  nodeIdentity, packAll, paintOf, railUsage, sideDy, sideOf, sourceOf, toDxf, unitsOf, walk,
  type AsmArray, type AsmLayout, type AsmMount, type AsmSide, type BomNode, type MechIssue,
} from "@fpl/core";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { fmtN, type Catalog } from "../bom/shared";
import { Modal, useLocal, useUi } from "../ui";
import { DT_MECH, IssueList, LenIn, PaletteItem, download, downloadSvg, useSplit, useViewGate, useViews, useZoom, viewHref, type Len, type MechDrag } from "./common";

const PAD = 30;
type ArrSpec = Omit<AsmArray, "id">;
const ARR_DEFAULT: ArrSpec = { n: 3, gap: 0.01, left: 0.01, right: 0.02, useLeft: true, useRight: true };

/** Label of a top-level child (source) of an assembly. */
export function sourceLabel(n: BomNode, cat: Catalog, nos?: Map<string, string>): string {
  const no = nos?.get(n.id);
  if (n.kind === "group") return `${no ? `${no} ` : ""}${n.alias || n.name || n.tags[0] || "(group)"}${n.tags[0] ? ` (-${n.tags[0]})` : ""}`;
  const id = nodeIdentity(n, cat.ctx);
  return `${no ? `${no} ` : ""}${id.partNumber}${n.tags[0] ? ` (-${n.tags[0]})` : ""}`;
}

/** Drawing of an assembly: plate(s), rails and devices; rack-mounted assemblies show the front (top) and the rear (bottom). */
export function AsmSvg({ l, group, cat, sel, issues, svgRef, z, onDown, onMove, onUp, onBg }: {
  l: AsmLayout; group: BomNode; cat: Catalog; sel?: string | null; issues?: MechIssue[]; svgRef?: React.Ref<SVGSVGElement>; z: number;
  onDown?: (e: React.PointerEvent, id: string) => void; onMove?: (e: React.PointerEvent) => void; onUp?: () => void; onBg?: () => void;
}) {
  const gate = useViewGate();
  const ids = useMemo(() => {
    const s = new Set<string>();
    walk(group.children, (n) => n.partId && s.add(n.partId));
    return [...s];
  }, [group]);
  const { views } = useViews(ids);
  const usage = useMemo(() => railUsage(l, group, cat.ctx), [l, group, cat.ctx]);
  const sides: AsmSide[] = hasRear(l) ? ["front", "rear"] : ["front"];
  const H = hasRear(l) ? 2 * l.heightMm + 40 : l.heightMm;
  const size = (nodeId: string) => {
    const s = itemSize(findNode([group], nodeId)?.node, cat.ctx);
    return { w: s.w ?? UNKNOWN_W, h: s.h ?? UNKNOWN_H };
  };
  const virt = l.mount === "rail";
  return (
    <svg ref={svgRef} viewBox={`${-PAD} ${-PAD} ${l.widthMm + 2 * PAD} ${H + 2 * PAD}`} width={(l.widthMm + 2 * PAD) * z} height={(H + 2 * PAD) * z} className="mechsvg asmsvg"
      onPointerMove={onMove} onPointerUp={onUp} onPointerDown={onBg}>
      {sides.map((side) => {
        const dy = sideDy(l, side);
        return (
          <g key={side} transform={`translate(0 ${dy})`} data-side={side}>
            {hasRear(l) && <text data-ui x={0} y={-6} className="unum sidelbl">{side === "rear" ? "REAR (bottom)" : "FRONT (top)"}</text>}
            {!virt && <rect x={0} y={0} width={l.widthMm} height={l.heightMm} className="plate" />}
            {virt && <rect data-ui x={0} y={0} width={l.widthMm} height={l.heightMm} className="virtplate" />}
            {l.mount === "rack" && <><rect x={0} y={0} width={16} height={l.heightMm} className="rail" /><rect x={l.widthMm - 16} y={0} width={16} height={l.heightMm} className="rail" /></>}
            {l.rails.map((r, i) => {
              const u = usage.get(side === "rear" ? `${r.id}|rear` : r.id);
              return (
                <g key={r.id}>
                  <rect x={r.x} y={r.y - DIN_RAIL_H / 2} width={r.length} height={DIN_RAIL_H} className={`dinrail${virt ? " virt" : ""}${(u?.used ?? 0) > r.length ? " over" : ""}`} />
                  <text data-ui x={r.x - 4} y={r.y + 3} textAnchor="end" className="unum">R{i + 1}</text>
                </g>
              );
            })}
            {(l.arrays ?? []).map((a) => {
              const m = arrayMembers(l, a.id).filter((it) => sideOf(it) === side);
              if (m.length < 2) return null;
              const first = m[0];
              const last = m[m.length - 1];
              const rail = l.rails.find((r) => r.id === first.railId);
              const s = size(first.nodeId);
              const y = rail ? rail.y - s.h / 2 : first.y;
              const x0 = first.x - itemPad(l, first).l;
              const x1 = last.x + size(last.nodeId).w + itemPad(l, last).r;
              return (
                <g key={a.id} data-ui className="arrmark">
                  <rect x={x0} y={y - 4} width={x1 - x0} height={s.h + 8} />
                  <text x={x1} y={y + s.h + 11} textAnchor="end">×{m.length}</text>
                </g>
              );
            })}
            {l.items.filter((it) => sideOf(it) === side).map((it) => {
              const n = findNode([group], it.nodeId)?.node;
              const s = size(it.nodeId);
              const rail = l.rails.find((r) => r.id === it.railId);
              const y = rail ? rail.y - s.h / 2 : it.y;
              const v = n?.partId ? gate(cat.pmap.get(n.partId), views.get(n.partId)?.front) : undefined;
              const bad = issues?.some((i) => i.id === it.id && i.level === "error");
              const paint = paintOf(l, group, sourceOf(group, it.nodeId));
              return (
                <g key={it.id} data-id={it.id} className={`slot${sel === it.id ? " sel" : ""}${bad ? " bad" : ""}`} onPointerDown={onDown ? (e) => onDown(e, it.id) : undefined}>
                  <rect x={it.x} y={y} width={s.w} height={s.h} className="box" />
                  {viewHref(v) && <image href={viewHref(v)} x={it.x} y={y} width={s.w} height={s.h} preserveAspectRatio="none" />}
                  {paint && <rect x={it.x + paint.width / 2} y={y + paint.width / 2} width={Math.max(0.5, s.w - paint.width)} height={Math.max(0.5, s.h - paint.width)} fill="none" stroke={paint.color} strokeWidth={paint.width} className="srcpaint" />}
                  <text x={it.x + s.w / 2} y={y - 2} textAnchor="middle" className="lbl tiny">{n?.tags[it.inst] || (n ? nodeIdentity(n, cat.ctx).partNumber : "?")}</text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

/** Read-only preview (template library): fits the drawing to the pane. */
export function AsmPreview({ group, cat }: { group: BomNode; cat: Catalog }) {
  const zoom = useZoom("asmprev", 1.5);
  const l = group.layout;
  if (!l) return <div className="empty-state"><p>No layout in this template.</p></div>;
  const H = hasRear(l) ? 2 * l.heightMm + 40 : l.heightMm;
  return (
    <>
      <div className="toolbar sub"><span className="muted" style={{ fontSize: 12 }}>{ASM_MOUNTS.find(([m]) => m === l.mount)?.[1]}{l.mount === "rack" ? ` · ${l.rackUnits}U` : ""} · {Math.round(l.widthMm)} × {Math.round(l.heightMm)} mm</span><span className="grow" />{zoom.controls(l.widthMm + 2 * PAD, H + 2 * PAD)}</div>
      <div className="scroll canvasbox" ref={zoom.wrap}><AsmSvg l={l} group={group} cat={cat} z={zoom.z} /></div>
    </>
  );
}

/** Outline colour / width per source (BOM group, sub-assembly, part line or added batch) of an assembly. */
export function PaletteModal({ group, cat, nos, onChange, onClose }: { group: BomNode; cat: Catalog; nos?: Map<string, string>; onChange: (f: (l: AsmLayout) => AsmLayout) => void; onClose: () => void }) {
  const l = group.layout;
  if (!l) return null;
  const set = (id: string, p: Partial<{ color: string; width: number }>) =>
    onChange((x) => {
      const cur = paintOf(x, group, id) ?? { color: PALETTE_COLORS[0], width: 1 };
      return { ...x, palette: { ...(x.palette ?? {}), [id]: { ...cur, ...p } } };
    });
  return (
    <Modal size="sm" onClose={onClose} label="Source colours">
      <div className="mh"><h3>🎨 Source outlines</h3></div>
      <div className="mb">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Each device is outlined with the colour of the BOM group / sub-assembly (or added batch) it comes from, so the same part number from different sources can be told apart. Width in mm of the drawing.</p>
        <table className="mini wide palette-tbl">
          <thead><tr><th>Source</th><th>Colour</th><th>Width (mm)</th></tr></thead>
          <tbody>
            {group.children.map((c) => {
              const p = paintOf(l, group, c.id)!;
              return (
                <tr key={c.id}>
                  <td><span className="swatch" style={{ borderColor: p.color, borderWidth: Math.min(4, Math.max(1, p.width * 1.5)) }} /> {sourceLabel(c, cat, nos)}</td>
                  <td><input type="color" aria-label={`Colour of ${sourceLabel(c, cat, nos)}`} value={p.color} onChange={(e) => set(c.id, { color: e.target.value })} /></td>
                  <td><input type="number" aria-label={`Width of ${sourceLabel(c, cat, nos)}`} min={0.25} max={8} step={0.25} value={p.width} onChange={(e) => set(c.id, { width: Math.max(0.25, Math.min(8, Number(e.target.value) || 1)) })} style={{ width: 70 }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mf">
        <button type="button" onClick={() => onChange((x) => ({ ...x, palette: undefined }))}>Reset to defaults</button>
        <span className="grow" />
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/**
 * Layout editor of one assembly: plate, DIN rails (front + rear for rack-mounted assemblies) and devices.
 * `rightTop` is shown above the rails (e.g. the BOM quantity check of a project group).
 */
export function AsmEditor({ group, setGroup, cat, len, splitKey = "asm", nos, checkTab, onAddGroup }: {
  group: BomNode; setGroup: (f: (g: BomNode) => BomNode) => void; cat: Catalog; len: Len; splitKey?: string; nos?: Map<string, string>;
  /** First tab of the right panel (e.g. the BOM check of a project group), given the selected device's line. */
  checkTab?: (selNodeId: string | null) => ReactNode; onAddGroup?: () => void;
}) {
  const ui = useUi();
  const l = group.layout;
  const setL = (f: (l: AsmLayout) => AsmLayout) => setGroup((g) => (g.layout ? { ...g, layout: f(g.layout) } : g));
  const [sel, setSel] = useState<string | null>(null);
  const [paletteDlg, setPaletteDlg] = useState(false);
  const [arr, setArr] = useLocal<ArrSpec>("fpl.mech.arrayspec", ARR_DEFAULT);
  const [rtab, setRtab] = useLocal<"check" | "rails">("fpl.mech.asmrtab", "check");
  const svg = useRef<SVGSVGElement>(null);
  const zoom = useZoom("asm", 2);
  const split = useSplit(splitKey, 290, 360);
  const units = useMemo(() => unitsOf(group, cat.ctx), [group, cat.ctx]);
  const issues = useMemo(() => (l ? asmIssues(l, group, cat.ctx) : []), [l, group, cat.ctx]);
  const usage = useMemo(() => (l ? railUsage(l, group, cat.ctx) : new Map<string, { used: number; length: number }>()), [l, group, cat.ctx]);
  const drag = useRef<{ id: string; dx: number; dy: number; moved?: boolean } | null>(null);

  if (!l)
    return (
      <div className="empty-state">
        <h3>No layout yet for “{group.name || group.tags[0] || "this group"}”</h3>
        <p>Pick how the assembly is mounted. Its devices ({units.length}) are then placed on DIN rails or directly on the plate.</p>
        <div className="toolbar">
          <button type="button" className="btn-primary" onClick={() => setGroup((g) => ({ ...g, layout: emptyAsmLayout("din") }))}>DIN-rail / terminal-block assembly</button>
          <button type="button" onClick={() => setGroup((g) => ({ ...g, layout: emptyAsmLayout("rail") }))}>Rail group (no DIN rail)</button>
          <button type="button" onClick={() => setGroup((g) => ({ ...g, layout: emptyAsmLayout("rack", 4) }))}>Rack-mounted assembly (RMU)</button>
          {onAddGroup && <button type="button" onClick={onAddGroup}>+ New group…</button>}
        </div>
      </div>
    );

  const H = hasRear(l) ? 2 * l.heightMm + 40 : l.heightMm;
  const pt = (e: { clientX: number; clientY: number }) => {
    const m = svg.current?.getScreenCTM();
    return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : new DOMPoint();
  };
  /** Side under a drawing y (rack: below the front view = rear) and the y within that side. */
  const sideAt = (y: number): { side: AsmSide; y: number } => (hasRear(l) && y > l.heightMm + 20 ? { side: "rear", y: y - sideDy(l, "rear") } : { side: "front", y });
  const nearestRail = (y: number) => l.rails.slice().sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];
  const size = (nodeId: string) => {
    const s = itemSize(findNode([group], nodeId)?.node, cat.ctx);
    return { w: s.w ?? UNKNOWN_W, h: s.h ?? UNKNOWN_H };
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
    const at = sideAt(p.y);
    const s = size(d.nodeId);
    const rail = nearestRail(at.y);
    const node = findNode([group], d.nodeId)?.node;
    const onRail = !!rail && Math.abs(rail.y - at.y) < Math.max(40, s.h / 2) && (!node || nodeIdentity(node, cat.ctx).part?.mech.mount !== "panel");
    const it = { id: newId(), nodeId: d.nodeId, inst: d.inst, railId: onRail ? rail.id : null, x: Math.round(p.x - s.w / 2), y: Math.round(at.y - s.h / 2), t: Date.now(), ...(at.side === "rear" ? { side: "rear" as const } : {}) };
    setL((x) => ({ ...x, items: [...x.items, it] }));
    setSel(it.id);
  };
  const onDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    setSel(id);
    const it = l.items.find((i) => i.id === id)!;
    const p = pt(e);
    const rail = l.rails.find((r) => r.id === it.railId);
    const dy = sideDy(l, sideOf(it));
    drag.current = { id, dx: p.x - it.x, dy: p.y - dy - (rail ? rail.y - size(it.nodeId).h / 2 : it.y) };
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic event */
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.moved = true;
    const p = pt(e);
    setL((x) => {
      const it = x.items.find((i) => i.id === d.id);
      if (!it) return x;
      const nx = Math.round((p.x - d.dx) * 100) / 100;
      const at = sideAt(p.y);
      const s = size(it.nodeId);
      const moved = (i: typeof it) => {
        if (i.railId) {
          const r = nearestRail(at.y - d.dy + s.h / 2);
          return { ...i, railId: r?.id ?? i.railId, ...(at.side === "rear" ? { side: "rear" as const } : { side: undefined }) };
        }
        return { ...i, y: Math.round(at.y - d.dy), ...(at.side === "rear" ? { side: "rear" as const } : { side: undefined }) };
      };
      // An array moves as one block.
      const dx = nx - it.x;
      const block = it.arr ? new Set(arrayMembers(x, it.arr).map((m) => m.id)) : new Set([it.id]);
      return { ...x, items: x.items.map((i) => (block.has(i.id) ? { ...moved(i), x: Math.round((i.x + dx) * 100) / 100, t: Date.now() } : i)) };
    });
  };
  const selItem = l.items.find((i) => i.id === sel);
  const selNode = selItem ? findNode([group], selItem.nodeId)?.node : undefined;
  const selArr = selItem?.arr ? l.arrays?.find((a) => a.id === selItem.arr) : undefined;
  const placed = new Set(l.items.map((i) => `${i.nodeId}#${i.inst}`));
  const applyArr = (spec: ArrSpec) => {
    if (!selItem) return;
    const all = units.filter((u) => u.node.id === selItem.nodeId).map((u) => u.inst);
    const mine = selItem.arr ? new Set(arrayMembers(l, selItem.arr).map((m) => m.inst)) : new Set([selItem.inst]);
    const used = new Set(l.items.filter((i) => i.nodeId === selItem.nodeId).map((i) => i.inst));
    const free = all.filter((i) => !used.has(i) && !mine.has(i));
    let next = Math.max(-1, ...all, ...used) + 1;
    while (free.length < spec.n) free.push(next++);
    const now = Date.now();
    setL((x) => {
      const y = applyArray(x, selItem.id, spec, size(selItem.nodeId).w, free);
      return { ...y, items: y.items.map((i) => (i.nodeId === selItem.nodeId && (i.arr || i.id === selItem.id) && !x.items.some((o) => o.id === i.id && o.x === i.x && o.arr === i.arr) ? { ...i, t: now } : i)) };
    });
    setArr(spec);
  };
  const spec: ArrSpec = selArr ? { n: selArr.n, gap: selArr.gap, left: selArr.left, right: selArr.right, useLeft: selArr.useLeft, useRight: selArr.useRight } : arr;
  const editArr = (p: Partial<ArrSpec>) => (selArr ? applyArr({ ...spec, ...p }) : setArr({ ...spec, ...p }));
  const pal = (c: BomNode) => paintOf(l, group, c.id);

  return (
    <div className="mechwrap" style={{ gridTemplateColumns: split.cols }}>
      <section className="pane mpal">
        <div className="pane-head">
          <h3>Devices</h3><span className="muted">{new Set([...placed].filter((k) => units.some((u) => `${u.node.id}#${u.inst}` === k))).size}/{units.length} placed</span>
          <span className="grow" />
          <button type="button" className="btn-ghost" aria-label="Source colours" title="Outline colour and width per BOM group / sub-assembly (tell the same part number apart)" onClick={() => setPaletteDlg(true)}>🎨</button>
        </div>
        <div className="scroll">
          {group.children.map((c) => {
            const lines: BomNode[] = [];
            walk([c], (n) => n.kind === "part" && lines.push(n));
            const p = pal(c);
            return (
              <div key={c.id} className="srcblock">
                <div className="srchead" title="Source of these devices"><span className="swatch" style={{ borderColor: p?.color, borderWidth: Math.min(4, Math.max(1, (p?.width ?? 1) * 1.5)) }} />{sourceLabel(c, cat, nos)}</div>
                <ul className="srclist palette">
                  {lines.map((n) => {
                    const all = units.filter((u) => u.node.id === n.id);
                    const left = all.filter((u) => !placed.has(`${n.id}#${u.inst}`)).map((u) => u.inst);
                    const s = itemSize(n, cat.ctx);
                    return (
                      <PaletteItem key={n.id} n={n} cat={cat} left={left} total={all.length} extra={s.w != null ? `${fmtN(s.w, 1)} mm` : "w?"}
                        onDragStart={(inst) => (e) => (e.dataTransfer.setData(DT_MECH, JSON.stringify({ t: "node", nodeId: n.id, inst } satisfies MechDrag)), (e.dataTransfer.effectAllowed = "copy"))} />
                    );
                  })}
                  {!lines.length && <li className="muted" style={{ fontSize: 12 }}>no parts</li>}
                </ul>
              </div>
            );
          })}
        </div>
        {split.handle}
      </section>
      <section className="pane mcanvas">
        <div className="toolbar sub">
          <label className="ctl">Mounting
            <select value={l.mount} onChange={(e) => {
              const m = e.target.value as AsmMount;
              setL((x) => ({
                ...x, mount: m,
                ...(m === "rack" ? { widthMm: 482.6, heightMm: (x.rackUnits ?? 4) * U_MM, rackUnits: x.rackUnits ?? 4 } : { rackUnits: null, items: x.items.map((i) => (i.side ? { ...i, side: undefined } : i)) }),
              }));
            }}>
              {ASM_MOUNTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
          </label>
          {l.mount === "rack" && (
            <label className="ctl">U
              <select value={l.rackUnits ?? 4} onChange={(e) => setL((x) => ({ ...x, rackUnits: Number(e.target.value), heightMm: Number(e.target.value) * U_MM }))}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((u) => <option key={u} value={u}>{u}U</option>)}
              </select>
            </label>
          )}
          <label className="ctl">{l.mount === "rail" ? "Extent W" : "Plate W"}<LenIn len={len} label="Plate width" value={l.widthMm} onChange={(v) => v && setL((x) => ({ ...x, widthMm: v }))} width={70} /></label>
          <label className="ctl">H<LenIn len={len} label="Plate height" value={l.heightMm} onChange={(v) => v && setL((x) => ({ ...x, heightMm: v }))} width={70} /></label>
          <label className="ctl" title="Blank = deepest device">Depth<LenIn len={len} label="Depth" value={l.depthMm} onChange={(v) => setL((x) => ({ ...x, depthMm: v }))} width={60} /></label>
          <span className="sep" />
          <button type="button" onClick={() => setL((x) => {
            const y = autoArrange(x, group, cat.ctx);
            const now = Date.now();
            const had = new Set(x.items.map((i) => i.id));
            return { ...y, items: y.items.map((i) => (had.has(i.id) ? i : { ...i, t: now })) };
          })} title="Place every unplaced device in BOM order (front rails)">Auto-arrange</button>
          <button type="button" onClick={() => setL((x) => packAll(x, group, cat.ctx))} title="Close gaps on every rail (array spacing kept)">Pack rails</button>
          <button type="button" onClick={async () => (await ui.confirm("Remove every placed device from the layout?", "Clear")) && setL((x) => ({ ...x, items: [], arrays: [] }))}>Clear</button>
          <span className="grow" />
          {zoom.controls(l.widthMm + 2 * PAD, H + 2 * PAD)}
          <button type="button" onClick={() => downloadSvg(svg.current, `${group.name || "assembly"} layout.svg`)}>SVG</button>
          <button type="button" onClick={() => download(`${group.name || "assembly"} layout.dxf`, toDxf(asmShapes(l, group, cat.ctx)), "application/dxf")}>DXF</button>
        </div>
        {l.mount === "rail" && <p className="muted hintline">Rail group: the rails are construction lines (no DIN-rail part); the devices clip onto a rail of the enclosure or assembly they are placed in.</p>}
        <div className="scroll canvasbox" ref={zoom.wrap} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <AsmSvg l={l} group={group} cat={cat} sel={sel} issues={issues} svgRef={svg} z={zoom.z} onDown={onDown} onMove={onMove} onUp={() => (drag.current = null)} onBg={() => setSel(null)} />
        </div>
        {onAddGroup && <button type="button" className="btn-primary fab" onClick={onAddGroup} title="New group: pick BOM groups / part lines, master parts or a template">+ New group</button>}
      </section>
      <section className="pane minsp">
        {split.rightHandle}
        {selItem && selNode && (
          <div className="selbox">
            <b>{selNode.tags[selItem.inst] ? `-${selNode.tags[selItem.inst]}` : nodeIdentity(selNode, cat.ctx).partNumber}</b>
            <span className="muted"> {nodeIdentity(selNode, cat.ctx).description}</span>
            <div className="frow tight">
              <label className="f">x<LenIn len={len} label="x" value={selItem.x} width={70} onChange={(v) => v != null && setL((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, x: v, t: Date.now() } : i)) }))} /></label>
              <label className="f">On
                <select value={selItem.railId ?? ""} onChange={(e) => setL((x) => ({ ...x, items: x.items.map((i) => (i.id === selItem.id ? { ...i, railId: e.target.value || null } : i)) }))}>
                  {l.rails.map((r, i) => <option key={r.id} value={r.id}>Rail {i + 1}</option>)}
                  <option value="">Plate (no rail)</option>
                </select>
              </label>
              {hasRear(l) && (
                <label className="f">Side
                  <select value={sideOf(selItem)} onChange={(e) => {
                    const side = e.target.value === "rear" ? ("rear" as const) : undefined;
                    const ids = selItem.arr ? new Set(arrayMembers(l, selItem.arr).map((m) => m.id)) : new Set([selItem.id]);
                    setL((x) => ({ ...x, items: x.items.map((i) => (ids.has(i.id) ? { ...i, side, t: Date.now() } : i)) }));
                  }}>
                    <option value="front">Front (top)</option>
                    <option value="rear">Rear (bottom)</option>
                  </select>
                </label>
              )}
              <button type="button" className="btn-danger" style={{ alignSelf: "flex-end" }} onClick={() => {
                const ids = new Set([selItem.id]);
                setL((x) => {
                  const items = x.items.filter((i) => !ids.has(i.id));
                  const arrays = (x.arrays ?? []).filter((a) => items.some((i) => i.arr === a.id));
                  return { ...x, items, arrays: arrays.map((a) => ({ ...a, n: items.filter((i) => i.arr === a.id).length })) };
                });
                setSel(null);
              }}>Remove</button>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>{(() => {
              const s = itemSize(selNode, cat.ctx);
              return `${s.w != null ? fmtN(s.w, 1) : "?"} × ${s.h != null ? fmtN(s.h, 1) : "?"} × ${s.d != null ? fmtN(s.d, 1) : "?"} mm (DIN width × height × depth, adders included)`;
            })()}</span>
            {selItem.railId && (
              <fieldset className="arrbox" aria-label="Array">
                <legend>Array {selArr ? `(×${selArr.n})` : ""}</legend>
                <div className="frow tight">
                  <label className="f">Pieces<input type="number" aria-label="Array pieces" min={1} max={200} value={spec.n} onChange={(e) => editArr({ n: Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 1))) })} style={{ width: 60 }} /></label>
                  <label className="f">Between<LenIn len={len} label="Spacing between pieces" value={spec.gap} width={70} onChange={(v) => editArr({ gap: Math.max(0, v ?? 0) })} /></label>
                </div>
                <div className="frow tight">
                  <label className="chk-l" style={{ alignSelf: "flex-end" }}><input type="checkbox" aria-label="Left spacing on" checked={spec.useLeft} onChange={(e) => editArr({ useLeft: e.target.checked })} /> Left</label>
                  <label className="f"><LenIn len={len} label="Left spacing" value={spec.left} width={70} onChange={(v) => editArr({ left: Math.max(0, v ?? 0) })} /></label>
                  <label className="chk-l" style={{ alignSelf: "flex-end" }}><input type="checkbox" aria-label="Right spacing on" checked={spec.useRight} onChange={(e) => editArr({ useRight: e.target.checked })} /> Right</label>
                  <label className="f"><LenIn len={len} label="Right spacing" value={spec.right} width={70} onChange={(v) => editArr({ right: Math.max(0, v ?? 0) })} /></label>
                </div>
                <div className="frow tight">
                  {!selArr && <button type="button" className="btn-primary" onClick={() => applyArr(spec)} disabled={spec.n < 2}>Make array of {spec.n}</button>}
                  {selArr && <button type="button" onClick={() => applyArr({ ...spec, n: 1 })}>Dissolve array</button>}
                  <span className="muted" style={{ fontSize: 11.5, alignSelf: "center" }}>Pack rails keeps this spacing.</span>
                </div>
              </fieldset>
            )}
          </div>
        )}
        {checkTab && (
          <div className="tabs rtabs" role="tablist" aria-label="Right panel">
            <button type="button" role="tab" className="tab" aria-selected={rtab === "check"} onClick={() => setRtab("check")}>BOM check</button>
            <button type="button" role="tab" className="tab" aria-selected={rtab === "rails"} onClick={() => setRtab("rails")}>Rails &amp; checks{issues.some((x) => x.level === "error") ? " ⚠" : ""}</button>
          </div>
        )}
        {checkTab && rtab === "check" ? checkTab(selItem?.nodeId ?? null) : (
          <>
          <div className="pane-head"><h3>{l.mount === "rail" ? "Rails (construction lines)" : hasRear(l) ? "DIN rails (front = rear)" : "DIN rails"}</h3><button type="button" className="btn-ghost" onClick={() => setL((x) => ({ ...x, rails: [...x.rails, { id: newId(), x: x.rails[0]?.x ?? 0, y: Math.min(x.heightMm - 20, (x.rails[x.rails.length - 1]?.y ?? 0) + 110), length: x.rails[0]?.length ?? x.widthMm }] }))}>+ Rail</button></div>
          <div className="inspf">
            {l.rails.map((r, i) => {
              const u = usage.get(r.id);
              const ur = usage.get(`${r.id}|rear`);
              return (
                <div key={r.id} className="frow tight">
                  <b style={{ alignSelf: "flex-end" }}>R{i + 1}</b>
                  <label className="f">y (centre)<LenIn len={len} label="Rail y" value={r.y} width={60} onChange={(v) => v != null && setL((x) => ({ ...x, rails: x.rails.map((q) => (q.id === r.id ? { ...q, y: v } : q)) }))} /></label>
                  <label className="f">x<LenIn len={len} label="Rail x" value={r.x} width={55} onChange={(v) => v != null && setL((x) => ({ ...x, rails: x.rails.map((q) => (q.id === r.id ? { ...q, x: v } : q)) }))} /></label>
                  <label className="f">Length<LenIn len={len} label="Rail length" value={r.length} width={60} onChange={(v) => v && setL((x) => ({ ...x, rails: x.rails.map((q) => (q.id === r.id ? { ...q, length: v } : q)) }))} /></label>
                  <span className={`muted${u && u.used > u.length ? " errtxt" : ""}`} style={{ alignSelf: "flex-end", fontSize: 12 }}>{len.fmt(u?.used ?? 0, 0)}{ur ? ` / rear ${len.fmt(ur.used, 0)}` : ""} used</span>
                  <button type="button" className="btn-ghost btn-danger" style={{ alignSelf: "flex-end" }} aria-label="Delete rail" onClick={() => setL((x) => ({ ...x, rails: x.rails.filter((q) => q.id !== r.id), items: x.items.map((it) => (it.railId === r.id ? { ...it, railId: null } : it)) }))}>✕</button>
                </div>
              );
            })}
          </div>
          <div className="pane-head"><h3>Checks</h3></div>
          <div className="scroll"><IssueList issues={issues} onPick={setSel} /></div>
          </>
        )}
      </section>
      {paletteDlg && <PaletteModal group={group} cat={cat} nos={nos} onChange={setL} onClose={() => setPaletteDlg(false)} />}
    </div>
  );
}
