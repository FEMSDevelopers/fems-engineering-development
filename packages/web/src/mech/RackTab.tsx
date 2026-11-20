import {
  RACK_WIDTH_MM, U_MM, emptyRack, findNode, freeU, newId, nodeIdentity, partDims, placeSlot, rackCandidates, rackIssues, rackShapes, rackUnitsOf,
  slotLabel, slotsCollide, toDxf, walk, type BomNode, type Part, type RackLayout, type RackSlot,
} from "@fpl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { importViewFile } from "../bom/PartViews";
import { PartEditor } from "../bom/PartEditor";
import { NumIn, fmtN, type Catalog } from "../bom/shared";
import { errMsg } from "../api";
import { useUi } from "../ui";
import { DT_MECH, DescText, DevicePanel, PartBalloons, placeTags, EquipTable, IssueList, LinkBox, NotInLayout, ShiftPrompt, TagBubbles, UnitBom, addFromBom, download, downloadSvg, stOf, tagsOf, updateLinks, useSplit, useViewGate, useViews, useZoom, viewHref, type DescOf, type DevCtx, type MechDrag, type Ov } from "./common";
import type { TagDisplay } from "@fpl/core";

const GAP = 160; // between the front and rear elevations (mm)
const RAIL = 16; // rack ear / rail width drawn each side (mm)

/** Rack elevation: drag 19" equipment and rack-mounted assemblies from the unit's BOM into U positions (front and rear). */
export function RackTab({ unit, setUnit, cat, ov, bomUnit = null, display = "both", descOf, dc }: { unit: BomNode; setUnit: (f: (u: BomNode) => BomNode) => void; cat: Catalog; ov?: Ov; bomUnit?: BomNode | null; display?: TagDisplay; descOf?: DescOf; dc?: DevCtx }) {
  const split = useSplit("rack", 360);
  const gate = useViewGate();
  const [editPart, setEditPart] = useState<Part | null>(null);
  const ui = useUi();
  const rack: RackLayout = unit.rack ?? emptyRack(42);
  const setRack = (f: (r: RackLayout) => RackLayout) => setUnit((u) => ({ ...u, rack: f(u.rack ?? emptyRack(42)) }));
  // Parts marked "Full depth" in the master list take both faces.
  useEffect(() => {
    const need = rack.slots.filter((s) => !s.fullDepth && nodeIdentity(findNode([unit], s.nodeId)?.node ?? unit, cat.ctx).part?.mech.fullDepth);
    if (need.length) setRack((r) => ({ ...r, slots: r.slots.map((s) => (need.some((x) => x.id === s.id) ? { ...s, fullDepth: true } : s)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rack.slots, cat.ctx]);
  const [sel, setSel] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ slot: RackSlot; u: number; label: string } | null>(null);
  const [ghost, setGhost] = useState<{ u: number; h: number; face: "front" | "rear" } | null>(null);
  const [showBom, setShowBom] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const zoom = useZoom("rack", 0.7);
  const H = rack.totalU * U_MM;
  const W = RACK_WIDTH_MM * 2 + GAP + 110;

  const cands = useMemo(() => rackCandidates(unit, cat.ctx), [unit, cat.ctx]);
  const cabinets = useMemo(() => {
    const l: BomNode[] = [];
    walk(unit.children, (n) => n.kind === "part" && (nodeIdentity(n, cat.ctx).part?.mech.rackUnits ?? 0) >= 20 && l.push(n));
    return l;
  }, [unit, cat.ctx]);
  const issues = useMemo(() => rackIssues(rack, unit, cat.ctx), [rack, unit, cat.ctx]);
  const partIds = useMemo(() => rack.slots.map((s) => findNode([unit], s.nodeId)?.node.partId).filter((x): x is string => !!x), [rack.slots, unit]);
  const { views, refresh } = useViews(partIds);
  const usedU = useMemo(() => {
    const occ = new Set<string>();
    for (const s of rack.slots) for (let u = s.u; u < s.u + s.h; u++) occ.add(`${s.face}${u}`), s.fullDepth && occ.add(`${s.face === "front" ? "rear" : "front"}${u}`);
    return { front: [...occ].filter((x) => x.startsWith("front")).length, rear: [...occ].filter((x) => x.startsWith("rear")).length };
  }, [rack.slots]);

  /** Mouse position → (face, top U under the cursor). */
  const locate = (clientX: number, clientY: number) => {
    const el = svg.current;
    if (!el) return null;
    const m = el.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    const face: "front" | "rear" = p.x > 30 + RACK_WIDTH_MM + GAP / 2 ? "rear" : "front";
    const topU = Math.max(1, Math.min(rack.totalU, Math.ceil((40 + H - p.y) / U_MM)));
    return { face, topU };
  };
  const heightOf = (n: BomNode) => rackUnitsOf(n, cat.ctx) ?? 1;

  /** Place (or move) a slot; asks how to make room when the position is taken. */
  const place = (slot: RackSlot, u: number) => {
    const probe = { ...slot, u };
    const others = rack.slots.filter((s) => s.id !== slot.id);
    if (probe.u < 1 || probe.u + probe.h - 1 > rack.totalU) return ui.toast(`Doesn't fit: U${probe.u}–U${probe.u + probe.h - 1} of ${rack.totalU}U`);
    if (others.some((s) => slotsCollide(s, probe))) {
      const n = findNode([unit], slot.nodeId)?.node;
      setPrompt({ slot, u, label: n ? slotLabel(slot, n, cat.ctx) : "this item" });
      return;
    }
    setRack((r) => ({ ...r, slots: [...r.slots.filter((s) => s.id !== slot.id), probe] }));
    setSel(slot.id);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setGhost(null);
    let d: MechDrag;
    try {
      d = JSON.parse(e.dataTransfer.getData(DT_MECH));
    } catch {
      return;
    }
    const at = locate(e.clientX, e.clientY);
    const n = findNode([unit], d.nodeId)?.node;
    if (!at || !n) return;
    const h = heightOf(n);
    const depth = partDims(nodeIdentity(n, cat.ctx).part).z;
    const fullDepth = !!nodeIdentity(n, cat.ctx).part?.mech.fullDepth || (depth != null && !!rack.depthMm && depth > rack.depthMm / 2);
    place({ id: newId(), nodeId: n.id, inst: d.inst, u: 0, h, face: at.face, fullDepth }, at.topU - h + 1);
  };

  // Drag a placed slot (pointer events inside the SVG).
  const drag = useRef<{ id: string; dy: number; moved: boolean } | null>(null);
  const onSlotDown = (e: React.PointerEvent, s: RackSlot) => {
    e.stopPropagation();
    setSel(s.id);
    const at = locate(e.clientX, e.clientY);
    drag.current = { id: s.id, dy: at ? at.topU - (s.u + s.h - 1) : 0, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const s = rack.slots.find((x) => x.id === d.id);
    const at = locate(e.clientX, e.clientY);
    if (!s || !at) return;
    d.moved = true;
    setGhost({ u: at.topU - d.dy - s.h + 1, h: s.h, face: at.face });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    const g = ghost;
    setGhost(null);
    if (!d?.moved || !g) return;
    const s = rack.slots.find((x) => x.id === d.id);
    if (!s || (s.u === g.u && s.face === g.face)) return;
    place({ ...s, face: g.face }, g.u);
  };

  const selSlot = rack.slots.find((s) => s.id === sel);
  const selNode = selSlot ? findNode([unit], selSlot.nodeId)?.node : undefined;
  const placedCount = (n: BomNode) => new Set(rack.slots.filter((s) => s.nodeId === n.id).map((s) => s.inst));

  const elevation = (face: "front" | "rear", ox: number) => (
    <g key={face}>
      <text x={ox + RACK_WIDTH_MM / 2} y={H + 75} textAnchor="middle" className="cap">{`${unit.tags[0] ?? unit.name} — ${face === "front" ? "FRONT" : "REAR"} VIEW`}</text>
      <rect x={ox} y={40} width={RACK_WIDTH_MM} height={H} className="rackframe" />
      <rect x={ox} y={40} width={RAIL} height={H} className="rail" />
      <rect x={ox + RACK_WIDTH_MM - RAIL} y={40} width={RAIL} height={H} className="rail" />
      {Array.from({ length: rack.totalU }, (_, i) => {
        const u = i + 1;
        const y = 40 + H - u * U_MM;
        return (
          <g key={u}>
            <line x1={ox - 26} x2={ox} y1={y} y2={y} className="uline" />
            <text x={ox - 6} y={y + U_MM / 2 + 5} textAnchor="end" className="unum">{u}</text>
          </g>
        );
      })}
      {ghost && ghost.face === face && <rect data-ui x={ox} y={40 + H - (ghost.u + ghost.h - 1) * U_MM} width={RACK_WIDTH_MM} height={ghost.h * U_MM} className="ghost" />}
      {rack.slots
        .filter((s) => s.face === face || s.fullDepth)
        .map((s) => {
          const n = findNode([unit], s.nodeId)?.node;
          const part = n ? nodeIdentity(n, cat.ctx).part : undefined;
          const own = s.face === face;
          const v = part ? gate(part, views.get(part.id)?.[face === "front" ? "front" : "back"]) : undefined;
          const y = 40 + H - (s.u + s.h - 1) * U_MM;
          const bad = issues.some((i) => i.id === s.id && i.level === "error");
          const st = stOf(ov, s.nodeId);
          return (
            <g key={s.id + face} className={`slot${sel === s.id ? " sel" : ""}${bad ? " bad" : ""}${own ? "" : " shadow"} st-${st}`} onPointerDown={(e) => onSlotDown(e, s)}>
              <rect x={ox + 2} y={y + 1} width={RACK_WIDTH_MM - 4} height={s.h * U_MM - 2} className="box" />
              {own && viewHref(v) ? (
                <image href={viewHref(v)} x={ox + 2} y={y + 1} width={RACK_WIDTH_MM - 4} height={s.h * U_MM - 2} preserveAspectRatio="none" />
              ) : null}
              {(() => {
                const hh = s.h * U_MM;
                const showPn = display !== "tag";
                const tags = n && display !== "pn" ? placeTags(ov, dc, n, s) : [];
                const d = n ? (descOf ? descOf(n) : { left: n.kind === "group" ? n.alias || n.name || "assembly" : `${nodeIdentity(n, cat.ctx).manufacturer}\n${nodeIdentity(n, cat.ctx).partNumber}`, right: "" }) : { left: "?", right: "" };
                const side = (RACK_WIDTH_MM - 2 * RAIL) * 0.3;
                return (
                  <>
                    {(() => {
                      // Make room for part-line balloons placed inside on the left / right.
                      const inL = own && (s.labels ?? []).some((l) => !l.out && (l.pos === "L" || l.pos === "TL" || l.pos === "BL"));
                      const inR = own && (s.labels ?? []).some((l) => !l.out && (l.pos === "R" || l.pos === "TR" || l.pos === "BR"));
                      const pad = Math.max(16, Math.min(34, hh * 0.55));
                      return (
                        <>
                          {showPn && s.showText !== false && <DescText x={ox + RAIL + 6 + (inL ? pad : 0)} y={y} h={hh} text={d.left} maxW={RACK_WIDTH_MM * 0.32 - (inL ? pad : 0)} />}
                          {showPn && s.showText !== false && <DescText x={ox + RACK_WIDTH_MM - RAIL - 6 - (inR ? pad : 0)} y={y} h={hh} text={d.right} anchor="end" maxW={RACK_WIDTH_MM * 0.32 - (inR ? pad : 0)} />}
                        </>
                      );
                    })()}
                    {own && <PartBalloons box={{ x: ox + 2, y: y + 1, w: RACK_WIDTH_MM - 4, h: hh - 2 }} labels={s.labels} dc={dc} size={Math.max(7, Math.min(11, hh * 0.22))} />}
                    {<TagBubbles cx={ox + RACK_WIDTH_MM / 2} cy={y + hh / 2} tags={tags} maxW={showPn ? RACK_WIDTH_MM - 2 * RAIL - 2 * side : RACK_WIDTH_MM - 40} size={Math.max(8, Math.min(14, hh * 0.28))} />}
                  </>
                );
              })()}
            </g>
          );
        })}
    </g>
  );

  return (
    <div className="mechwrap" style={{ gridTemplateColumns: split.cols }}>
      <section className="pane mpal">
        {split.handle}
        <div className="pane-head"><h3>Rack equipment</h3><span className="muted">{usedU.front}U front · {usedU.rear}U rear used of {rack.totalU}U</span></div>
        <div className="scroll">
          <EquipTable
            rows={cands.map((c) => {
              const used = placedCount(c.node);
              return { n: c.node, total: c.count, left: Array.from({ length: c.count }, (_, i) => i).filter((i) => !used.has(i)), size: c.u ? `${c.u}U` : "U?" };
            })}
            cat={cat}
            ov={ov}
            sel={selNode?.id}
            onDragStart={(n, inst) => (e) => {
              e.dataTransfer.setData(DT_MECH, JSON.stringify({ t: "node", nodeId: n.id, inst } satisfies MechDrag));
              e.dataTransfer.effectAllowed = "copy";
            }}
            empty={<>No rack-mountable lines in this layout. Set “Mounting: 19&quot; rack” and the rack units on the parts (Parts &amp; BOM), add parts in “Edit this rack's equipment”, or give an assembly a rack-mounted layout in the Assemblies tab.</>}
          />
        </div>
        <NotInLayout ov={ov} cat={cat} onAdd={(b, q) => setUnit((u) => addFromBom(u, b, q))} />
        <div className="pane-head"><button type="button" className="btn-ghost" onClick={() => setShowBom(!showBom)}>{showBom ? "▾" : "▸"} Edit this rack's equipment (master parts)</button></div>
        {showBom && <div className="ubwrap"><UnitBom unit={unit} setUnit={setUnit} cat={cat} focus={selNode?.id} /></div>}
      </section>
      <section className="pane mcanvas">
        <div className="toolbar sub">
          <label className="ctl">Cabinet
            <select value={rack.cabinetNodeId ?? ""} onChange={(e) => {
              const n = cabinets.find((x) => x.id === e.target.value);
              const p = n ? nodeIdentity(n, cat.ctx).part : undefined;
              setRack((r) => ({ ...r, cabinetNodeId: n?.id ?? null, totalU: p?.mech.rackUnits ?? r.totalU, depthMm: p?.mech.depthMm ?? r.depthMm }));
            }}>
              <option value="">—</option>
              {cabinets.map((n) => <option key={n.id} value={n.id}>{nodeIdentity(n, cat.ctx).partNumber} ({nodeIdentity(n, cat.ctx).part?.mech.rackUnits}U)</option>)}
            </select>
          </label>
          <label className="ctl">Rack U<NumIn label="Rack units" value={rack.totalU} width={50} onChange={(v) => setRack((r) => ({ ...r, totalU: Math.max(1, Math.round(v ?? 42)) }))} /></label>
          <label className="ctl">Usable depth (mm)<NumIn label="Usable depth" value={rack.depthMm} width={70} onChange={(v) => setRack((r) => ({ ...r, depthMm: v }))} /></label>
          <span className="grow" />
          {zoom.controls(W, H + 100)}
          <button type="button" onClick={() => downloadSvg(svg.current, `${unit.tags[0] ?? "rack"} elevation.svg`)}>SVG</button>
          <button type="button" onClick={() => download(`${unit.tags[0] ?? "rack"} elevation.dxf`, toDxf(rackShapes(rack, unit, cat.ctx)), "application/dxf")}>DXF</button>
        </div>
        <div className="scroll canvasbox" ref={zoom.wrap} onDragOver={(e) => {
          e.preventDefault();
          const at = locate(e.clientX, e.clientY);
          if (at) setGhost({ u: at.topU, h: 1, face: at.face });
        }} onDragLeave={() => setGhost(null)} onDrop={onDrop}>
          <svg
            ref={svg}
            viewBox={`-40 0 ${W} ${H + 100}`}
            width={W * zoom.z}
            height={(H + 100) * zoom.z}
            className="mechsvg"
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerDown={() => setSel(null)}
          >
            {elevation("front", 30)}
            {elevation("rear", 30 + RACK_WIDTH_MM + GAP)}
          </svg>
        </div>
      </section>
      <section className="pane minsp">
        {split.rightHandle}
        {selSlot && selNode ? (
          <div className="inspf">
            <div className="pane-head" style={{ padding: 0, border: 0 }}>
              <h3>{placeTags(ov, dc, selNode, selSlot).join(" ") || slotLabel(selSlot, selNode, cat.ctx)}</h3><span className="muted mono">U{selSlot.u}{selSlot.h > 1 ? `–U${selSlot.u + selSlot.h - 1}` : ""}</span>
              <span className="grow" />
              {selNode.kind === "part" && selNode.partId && cat.pmap.get(selNode.partId) && (
                <button type="button" className="btn-ghost" title="Settings and configuration of this part number (master parts list): mechanical, 2D views, full depth, Project PN, Assembly Descriptions…" onClick={() => setEditPart(cat.pmap.get(selNode.partId!)!)}>Edit part…</button>
              )}
            </div>
            <span className="muted" style={{ fontSize: 12.5 }}>{nodeIdentity(selNode, cat.ctx).manufacturer} {nodeIdentity(selNode, cat.ctx).partNumber} · {nodeIdentity(selNode, cat.ctx).description}</span>
            {stOf(ov, selNode.id) !== "ok" && <span className={`stnote st-${stOf(ov, selNode.id)}`}>{stOf(ov, selNode.id) === "missing" ? "Not on the referenced project BOM any more" : `Placed ${ov?.placed.get(selNode.id) ?? 0} of ${ov?.bomQty.get(selNode.id) ?? 0} on the project BOM`}</span>}
            <LinkBox node={selNode} bomUnit={bomUnit} cat={cat} onChange={(l) => setUnit((u) => updateLinks(u, selNode.id, l))} />
            <div className="frow tight">
              <label className="f">Bottom U<NumIn label="Bottom U" value={selSlot.u} width={60} onChange={(v) => v != null && place(selSlot, Math.round(v))} /></label>
              <label className="f">Height (U)<NumIn label="Height" value={selSlot.h} width={60} onChange={(v) => setRack((r) => ({ ...r, slots: r.slots.map((s) => (s.id === selSlot.id ? { ...s, h: Math.max(1, Math.min(10, Math.round(v ?? 1))) } : s)) }))} /></label>
              <label className="f">Face
                <select value={selSlot.face} onChange={(e) => place({ ...selSlot, face: e.target.value as "front" | "rear" }, selSlot.u)}>
                  <option value="front">Front</option><option value="rear">Rear</option>
                </select>
              </label>
            </div>
            <label className="chk-l"><input type="checkbox" checked={selSlot.fullDepth} onChange={(e) => setRack((r) => ({ ...r, slots: r.slots.map((s) => (s.id === selSlot.id ? { ...s, fullDepth: e.target.checked } : s)) }))} /> Full depth (blocks the same U at the rear)</label>
            <div className="toolbar">
              <button type="button" onClick={() => place(selSlot, selSlot.u + 1)}>↑ 1U</button>
              <button type="button" onClick={() => place(selSlot, selSlot.u - 1)}>↓ 1U</button>
              <button type="button" onClick={() => {
                const u = freeU(rack.slots.filter((s) => s.id !== selSlot.id), selSlot.h, rack.totalU, selSlot.face, true, selSlot.fullDepth);
                if (u == null) ui.toast("No free space of that height");
                else place(selSlot, u);
              }}>Top free</button>
              <button type="button" className="btn-danger" onClick={() => (setRack((r) => ({ ...r, slots: r.slots.filter((s) => s.id !== selSlot.id) })), setSel(null))}>Remove</button>
            </div>
            {selNode.kind === "part" && selNode.partId && (
              <div className="frow tight">
                {(["front", "back"] as const).map((v) => (
                  <label key={v} className="btn" title={`${v} face drawing for ${nodeIdentity(selNode, cat.ctx).partNumber} (SVG, DXF, PDF or image); stored on the part`}>
                    {views.get(selNode.partId!)?.[v] ? `Replace ${v} view…` : `Upload ${v} view…`}
                    <input type="file" accept=".svg,.dxf,.pdf,.png,.jpg,.jpeg" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      const p = nodeIdentity(selNode, cat.ctx).part;
                      try {
                        await importViewFile(selNode.partId!, v, f, { w: partDims(p).x ?? RACK_WIDTH_MM, h: selSlot.h * U_MM });
                        refresh();
                        ui.toast(`${v} view saved on ${p?.partNumber}`);
                      } catch (er) {
                        ui.toast(errMsg(er));
                      }
                    }} />
                  </label>
                ))}
              </div>
            )}
            <DevicePanel ov={ov} dc={dc} node={selNode} place={selSlot} cat={cat} bomUnit={bomUnit} onChange={(devs) => setRack((r) => ({ ...r, slots: r.slots.map((s) => (s.id === selSlot.id ? { ...s, devs, dev: null, pin: null } : s)) }))}
              onLabels={(labels) => setRack((r) => ({ ...r, slots: r.slots.map((s) => (s.id === selSlot.id ? { ...s, labels } : s)) }))}
              onShowText={(v) => setRack((r) => ({ ...r, slots: r.slots.map((s) => (s.id === selSlot.id ? { ...s, showText: v ? undefined : false } : s)) }))} />
            <label className="f">Note<input type="text" value={selSlot.note ?? ""} onChange={(e) => setRack((r) => ({ ...r, slots: r.slots.map((s) => (s.id === selSlot.id ? { ...s, note: e.target.value || undefined } : s)) }))} /></label>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: 16 }}><p>Drag equipment from the left onto a U position (front or rear). Drag placed items to rearrange; when the spot is taken you choose to shift up or down and how much empty space to leave above.</p></div>
        )}
        <div className="pane-head"><h3>Checks</h3><span className="muted">{fmtN(rack.totalU * U_MM, 0)} mm high</span></div>
        <div className="scroll"><IssueList issues={issues} onPick={setSel} /></div>
      </section>
      {editPart && <PartEditor part={editPart} subcats={cat.subcats} parts={cat.parts} onSaved={(p) => (cat.putPart(p), refresh())} onClose={() => (setEditPart(null), refresh())} />}
      {prompt && (
        <ShiftPrompt label={prompt.label} h={prompt.slot.h} onDone={(r) => {
          const p = prompt;
          setPrompt(null);
          if (!r) return;
          const res = placeSlot(rack.slots, p.slot, p.u, r.mode, r.gap, rack.totalU);
          if (!res.ok) return ui.toast(res.msg ?? "Doesn't fit");
          setRack((x) => ({ ...x, slots: res.slots }));
          setSel(p.slot.id);
          if (res.moved) ui.toast(`${res.moved} item(s) shifted ${r.mode === "up" ? "up" : "down"}`);
        }} />
      )}
    </div>
  );
}
