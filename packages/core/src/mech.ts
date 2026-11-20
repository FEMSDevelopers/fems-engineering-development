/**
 * Mechanical design: part dimensions and 2D views, rack elevations (U slots), DIN-rail / terminal-block / rack-mounted
 * assembly layouts, and field-network-enclosure (FNE) back-panel layouts with wire ducts, conduits and assembly zones.
 * All lengths in mm. Panel / assembly coordinates: origin top-left, y downwards. Rack U numbers count from the bottom (1).
 */
import { findNode, newId, nodeIdentity, walk, type BomCtx, type BomNode, type Part } from "./bom.js";

export const IN_MM = 25.4;
export const U_MM = 44.45;
/** 19" rack: panel width and the opening between the rails. */
export const RACK_WIDTH_MM = 482.6;
export const RACK_OPENING_MM = 450;

// ───────────────────────── dimensions & views ─────────────────────────

export interface Dims3 {
  x: number | null;
  y: number | null;
  z: number | null;
}
/** Overall dimensions of a part: base x/y/z plus the clearance adders. */
export function partDims(p: Part | undefined | null): Dims3 & { base: Dims3; add: Dims3 } {
  const m = p?.mech;
  const base = { x: m?.widthMm ?? null, y: m?.heightMm ?? (m?.rackUnits ? m.rackUnits * U_MM : null), z: m?.depthMm ?? null };
  const add = { x: m?.addXMm ?? null, y: m?.addYMm ?? null, z: m?.addZMm ?? null };
  const sum = (b: number | null, a: number | null) => (b == null ? null : b + (a ?? 0));
  return { x: sum(base.x, add.x), y: sum(base.y, add.y), z: sum(base.z, add.z), base, add };
}

export const VIEW_NAMES = ["front", "back", "top", "bottom", "left", "right"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
/** Which part dimensions a view shows (horizontal, vertical). */
export const VIEW_AXES: Record<ViewName, ["x" | "y" | "z", "x" | "y" | "z"]> = {
  front: ["x", "y"], back: ["x", "y"], top: ["x", "z"], bottom: ["x", "z"], left: ["z", "y"], right: ["z", "y"],
};
export interface PartView {
  partId: string;
  view: ViewName;
  /** svg: SVG markup; image: data: URL (PNG / JPEG, e.g. a rendered PDF page). */
  kind: "svg" | "image";
  content: string;
  /** Extents of the drawing in mm (when known). */
  wMm: number | null;
  hMm: number | null;
  source: string;
  updatedAt?: string;
}

/** Size of a view's footprint from the part's overall dimensions. */
export function viewSize(p: Part | undefined, v: ViewName): { w: number | null; h: number | null } {
  const d = partDims(p);
  const [a, b] = VIEW_AXES[v];
  return { w: d[a], h: d[b] };
}

/** Units of each BOM part line, expanded by quantity: one entry per physical device (parts with mounting "Not mounted", e.g. fuses, are left out when the catalog is given). */
export function unitsOf(group: BomNode, ctx?: BomCtx): { node: BomNode; inst: number; tag: string }[] {
  const out: { node: BomNode; inst: number; tag: string }[] = [];
  walk(group.children, (n, parents) => {
    if (n.kind !== "part") return;
    if (ctx && nodeIdentity(n, ctx).part?.mech.mount === "none") return;
    const mult = parents.reduce((m, p) => m * Math.max(1, Math.round(p.qty || 1)), 1);
    const q = Math.max(0, Math.round((n.qty || 0) * mult));
    for (let i = 0; i < q; i++) out.push({ node: n, inst: i, tag: n.tags[i] ?? "" });
  });
  return out;
}

// ───────────────────────── rack elevation ─────────────────────────

export interface DeviceId {
  /** BOM line (part, group or sub-assembly) of the referenced project BOM. */
  bomId: string;
  /** Number without the prefix: "01", "01A". */
  num: string;
  /** Prefix defined in Mechanical Design for this device; empty / absent = the BOM line's prefix. */
  prefix?: string;
}
/** Where a part-line balloon sits around (or inside) a drawn device. */
export type LabelPos = "TL" | "T" | "TR" | "L" | "R" | "BL" | "B" | "BR";
export const LABEL_POS: [LabelPos, string][] = [["TL", "Top left"], ["T", "Top middle"], ["TR", "Top right"], ["L", "Left"], ["R", "Right"], ["BL", "Bottom left"], ["B", "Bottom middle"], ["BR", "Bottom right"]];
/** Part-line balloon of a linked BOM item on a placed device (item no. or part number). */
export interface PartLabel {
  bomId: string;
  pos: LabelPos;
  /** Outside the device outline (true) or inside its mechanical limits (false). */
  out: boolean;
  show: "item" | "pn";
}
/** Device IDs of a placed unit, one per linked BOM item (older layouts stored a single `dev`). */
export const devsOf = (p: { devs?: DeviceId[] | null; dev?: DeviceId | null }): DeviceId[] => p.devs ?? (p.dev ? [p.dev] : []);
export interface RackSlot {
  id: string;
  /** BOM part line or assembly group. */
  nodeId: string;
  /** Which unit of the line (0-based; a line of 3 servers has instances 0, 1, 2). */
  inst: number;
  /** Lowest U occupied (1 = bottom). */
  u: number;
  /** Height in U. */
  h: number;
  face: "front" | "rear";
  /** Blocks the same U on both faces (deep equipment). */
  fullDepth: boolean;
  /** Device tag chosen for this unit: BOM line id + tag index of the referenced project BOM (several lines may share a part number). */
  pin?: { id: string; inst: number } | null;
  /** Device ID defined in Mechanical Design: BOM line (item no.) it stands for + its number; tag = BOM prefix + number. */
  dev?: DeviceId | null;
  /** Device IDs per linked BOM item (replaces dev). */
  devs?: DeviceId[] | null;
  /** Part-line balloons of linked items. */
  labels?: PartLabel[] | null;
  /** Draw the BOM text (description / group title) on the device; false = only device tags and balloons. */
  showText?: boolean;
  note?: string;
}
export interface RackLayout {
  totalU: number;
  /** Usable depth between front and rear rails (for full-depth checks). */
  depthMm: number | null;
  /** BOM line of the cabinet itself. */
  cabinetNodeId?: string | null;
  slots: RackSlot[];
}
export const emptyRack = (totalU = 42): RackLayout => ({ totalU, depthMm: null, cabinetNodeId: null, slots: [] });

/** Rack units of a BOM line: the part's U, or an assembly's U (from its layout). */
export function rackUnitsOf(n: BomNode, ctx?: BomCtx): number | null {
  if (n.kind === "group") return n.layout?.rackUnits ?? null;
  const p = nodeIdentity(n, ctx).part;
  return p?.mech.rackUnits ?? null;
}
/** Rack-mountable lines of a unit: parts with U or mounted "rack", and assemblies with a rack layout. */
export function rackCandidates(unit: BomNode, ctx?: BomCtx): { node: BomNode; u: number | null; count: number }[] {
  const out: { node: BomNode; u: number | null; count: number }[] = [];
  walk(unit.children, (n, parents) => {
    const mult = parents.reduce((m, p) => m * Math.max(1, Math.round(p.qty || 1)), 1);
    const count = Math.max(0, Math.round((n.qty || 0) * mult));
    if (n.kind === "group") {
      if (n.layout?.mount === "rack" || (n.layout?.rackUnits ?? 0) > 0) out.push({ node: n, u: rackUnitsOf(n, ctx), count });
      return;
    }
    const p = nodeIdentity(n, ctx).part;
    // Cabinets (20U and taller) are the rack itself.
    if (p && (p.mech.mount === "rack" || (p.mech.rackUnits ?? 0) > 0) && (p.mech.rackUnits ?? 0) < 20) out.push({ node: n, u: p.mech.rackUnits ?? null, count });
  });
  // Lines inside a rack-mounted assembly are placed with the assembly, not on their own.
  const inAsm = new Set<string>();
  for (const c of out) if (c.node.kind === "group") walk(c.node.children, (x) => inAsm.add(x.id));
  return out.filter((c) => !inAsm.has(c.node.id));
}

const top = (s: RackSlot) => s.u + s.h - 1;
/** Two slots collide when their U ranges overlap on the same face (full-depth slots block both faces). */
export function slotsCollide(a: RackSlot, b: RackSlot): boolean {
  if (a.id === b.id) return false;
  if (a.u > top(b) || b.u > top(a)) return false;
  return a.face === b.face || a.fullDepth || b.fullDepth;
}

export type ShiftMode = "up" | "down" | "overlap";
/**
 * Put `moving` at U `u`. Slots that collide with it (and, in cascade, with each other) are shifted:
 *   up:   above the moved slot plus `gap` empty U;  down: below it (the `gap` stays above the moved slot);
 *   overlap: placed as is (collisions are reported by rackIssues).
 * Returns ok=false (and the unchanged list) when shifting would push something outside the rack.
 */
export function placeSlot(slots: RackSlot[], moving: RackSlot, u: number, mode: ShiftMode, gap: number, totalU: number): { slots: RackSlot[]; ok: boolean; moved: number; msg?: string } {
  const placed: RackSlot = { ...moving, u };
  const others = slots.filter((s) => s.id !== moving.id).map((s) => ({ ...s }));
  if (placed.u < 1 || top(placed) > totalU) return { slots, ok: false, moved: 0, msg: `U${u}–${top(placed)} is outside the ${totalU}U rack` };
  if (mode === "overlap") return { slots: [...others, placed], ok: true, moved: 0 };
  const block: RackSlot = { ...placed, h: placed.h + Math.max(0, gap) };
  let moved = 0;
  if (mode === "up") {
    // Cascade upwards in order of position.
    const fixed: RackSlot[] = [block];
    for (const s of others.slice().sort((a, b) => a.u - b.u)) {
      if (top(s) < placed.u) continue;
      let hit = fixed.filter((f) => slotsCollide(f, s));
      while (hit.length) {
        s.u = Math.max(...hit.map(top)) + 1;
        moved++;
        hit = fixed.filter((f) => slotsCollide(f, s));
      }
      fixed.push(s);
    }
  } else {
    const fixed: RackSlot[] = [block];
    for (const s of others.slice().sort((a, b) => top(b) - top(a))) {
      if (s.u > top(block)) continue;
      let hit = fixed.filter((f) => slotsCollide(f, s));
      while (hit.length) {
        s.u = Math.min(...hit.map((f) => f.u)) - s.h;
        moved++;
        hit = fixed.filter((f) => slotsCollide(f, s));
      }
      fixed.push(s);
    }
  }
  const out = others.find((s) => s.u < 1 || top(s) > totalU);
  if (out) return { slots, ok: false, moved: 0, msg: `Not enough room: shifting ${mode} would push equipment outside U1–U${totalU}` };
  void moved;
  const before = new Map(slots.map((x) => [x.id, x.u]));
  return { slots: [...others, placed], ok: true, moved: others.filter((x) => before.get(x.id) !== x.u).length };
}

/** Lowest free U range of height h on a face (from the top down when fromTop), or null. */
export function freeU(slots: RackSlot[], h: number, totalU: number, face: "front" | "rear", fromTop = true, fullDepth = false): number | null {
  const probe = (u: number): RackSlot => ({ id: "?", nodeId: "", inst: 0, u, h, face, fullDepth });
  const order = Array.from({ length: Math.max(0, totalU - h + 1) }, (_, i) => (fromTop ? totalU - h + 1 - i : i + 1));
  for (const u of order) if (!slots.some((s) => slotsCollide(s, probe(u)))) return u;
  return null;
}

export interface MechIssue {
  level: "error" | "warn";
  id?: string;
  msg: string;
}
export function rackIssues(r: RackLayout, unit: BomNode, ctx?: BomCtx): MechIssue[] {
  const out: MechIssue[] = [];
  const seen = new Map<string, number>();
  for (const s of r.slots) {
    const hit = findNode([unit], s.nodeId);
    if (!hit) {
      out.push({ level: "error", id: s.id, msg: "Placed line is no longer in this unit's BOM" });
      continue;
    }
    const label = slotLabel(s, hit.node, ctx);
    if (s.u < 1 || top(s) > r.totalU) out.push({ level: "error", id: s.id, msg: `${label}: U${s.u}–U${top(s)} outside the ${r.totalU}U rack` });
    const u = rackUnitsOf(hit.node, ctx);
    if (u != null && u !== s.h) out.push({ level: "warn", id: s.id, msg: `${label}: placed as ${s.h}U, the BOM says ${u}U` });
    const k = `${s.nodeId}#${s.inst}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (seen.get(k) === 2) out.push({ level: "error", id: s.id, msg: `${label} is placed twice` });
    const qty = Math.round(hit.node.qty || 0);
    if (s.inst >= qty) out.push({ level: "warn", id: s.id, msg: `${label}: unit ${s.inst + 1} of a line with quantity ${qty}` });
  }
  for (let i = 0; i < r.slots.length; i++)
    for (let j = i + 1; j < r.slots.length; j++)
      if (slotsCollide(r.slots[i], r.slots[j])) out.push({ level: "error", id: r.slots[j].id, msg: `U${Math.max(r.slots[i].u, r.slots[j].u)}: two items overlap` });
  if (r.depthMm) {
    for (const s of r.slots) {
      const hit = findNode([unit], s.nodeId);
      const d = hit ? partDims(nodeIdentity(hit.node, ctx).part).z : null;
      if (d != null && d > r.depthMm) out.push({ level: "error", id: s.id, msg: `${slotLabel(s, hit!.node, ctx)} is ${Math.round(d)} mm deep; the rack allows ${r.depthMm} mm` });
      else if (d != null && !s.fullDepth && d > r.depthMm / 2) out.push({ level: "warn", id: s.id, msg: `${slotLabel(s, hit!.node, ctx)} is deeper than half the rack; mark it full depth` });
    }
  }
  return out;
}
export function slotLabel(s: Pick<RackSlot, "inst">, n: BomNode, ctx?: BomCtx): string {
  const id = nodeIdentity(n, ctx);
  const tag = n.tags[s.inst];
  return tag ? `-${tag}` : n.kind === "group" ? n.name || "assembly" : id.partNumber || id.description;
}

// ───────────────────────── DIN-rail / terminal-block / rack-mounted assemblies ─────────────────────────

export interface DinRail {
  id: string;
  /** Centre line of the rail, mm from the top of the plate. */
  y: number;
  x: number;
  length: number;
}
/**
 * din: DIN-rail / terminal-block assembly on its own plate and rail(s).
 * rail: rail group: devices arranged as on a DIN rail that clip onto a rail of another assembly or enclosure
 *       (the rails are construction lines only; no plate, no rail part).
 * rack: rack-mounted assembly (RMU, n U) on a 19" plate with front and rear DIN rails (same rail layout on both sides).
 */
export type AsmMount = "din" | "rail" | "rack";
export const ASM_MOUNTS: [AsmMount, string][] = [
  ["din", "DIN-rail / terminal-block assembly"],
  ["rail", "Rail group — no DIN rail (mounts on an existing rail)"],
  ["rack", "Rack-mounted (RMU, front + rear rails)"],
];
export type AsmSide = "front" | "rear";
export interface AsmItem {
  id: string;
  nodeId: string;
  inst: number;
  /** Rail the item clips on (null = panel-mounted at x / y). */
  railId: string | null;
  /** Left edge (mm from the plate's left edge). */
  x: number;
  /** Panel-mounted items: top edge. */
  y: number;
  /** Rack-mounted assemblies: rear rail (absent = front). */
  side?: "rear";
  /** Member of an array (AsmLayout.arrays). */
  arr?: string;
  /** Last placed / moved (ms since epoch): "recent first" order of the BOM check. */
  t?: number;
}
/** A run of identical devices with defined spacing: between pieces, before the first (left) and after the last (right). */
export interface AsmArray {
  id: string;
  n: number;
  gap: number;
  left: number;
  right: number;
  useLeft: boolean;
  useRight: boolean;
}
/** Outline of the devices of one source (BOM group / sub-assembly / added parts), to tell the same part number apart. */
export interface AsmPaint {
  color: string;
  width: number;
}
export interface AsmLayout {
  mount: AsmMount;
  rackUnits: number | null;
  widthMm: number;
  heightMm: number;
  /** Depth of the assembly (null = deepest item). */
  depthMm: number | null;
  rails: DinRail[];
  items: AsmItem[];
  arrays?: AsmArray[];
  /** Top-level child of the assembly (source) → outline colour / width. */
  palette?: Record<string, AsmPaint>;
}
export const DIN_RAIL_H = 35;
/** Gap between the front and the rear view of a rack-mounted assembly in drawings. */
export const REAR_GAP_MM = 40;
export const PALETTE_COLORS = ["#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#7f7f7f"];
export function emptyAsmLayout(mount: AsmMount, rackUnits = 4): AsmLayout {
  if (mount === "rack") {
    const h = rackUnits * U_MM;
    return { mount, rackUnits, widthMm: RACK_WIDTH_MM, heightMm: h, depthMm: null, rails: [{ id: newId(), x: 16, y: h / 2, length: RACK_WIDTH_MM - 32 }], items: [] };
  }
  if (mount === "rail") return { mount, rackUnits: null, widthMm: 200, heightMm: 100, depthMm: null, rails: [{ id: newId(), x: 0, y: 50, length: 200 }], items: [] };
  return { mount, rackUnits: null, widthMm: 300, heightMm: 130, depthMm: null, rails: [{ id: newId(), x: 0, y: 65, length: 300 }], items: [] };
}
export const sideOf = (it: Pick<AsmItem, "side">): AsmSide => (it.side === "rear" ? "rear" : "front");
/** Rack-mounted assemblies have a rear side (same rails as the front). */
export const hasRear = (l: Pick<AsmLayout, "mount">) => l.mount === "rack";
/** Drawing offset of a side (the rear view sits below the front view). */
export const sideDy = (l: AsmLayout, side: AsmSide) => (side === "rear" ? l.heightMm + REAR_GAP_MM : 0);
/** Outline of a source (default: palette colour by index, 1 mm). */
export function paintOf(l: AsmLayout, group: BomNode, srcId: string | null): AsmPaint | null {
  if (!srcId) return null;
  const p = l.palette?.[srcId];
  if (p) return p;
  const i = group.children.findIndex((c) => c.id === srcId);
  return i < 0 ? null : { color: PALETTE_COLORS[i % PALETTE_COLORS.length], width: 1 };
}
/** Top-level child of the assembly that holds a node (its source). */
export function sourceOf(group: BomNode, nodeId: string): string | null {
  for (const c of group.children) if (c.id === nodeId || findNode(c.children, nodeId)) return c.id;
  return null;
}

/** Footprint of one device in an assembly: width on the rail (DIN width, else x), height (y), depth (z). Unknown sizes → null. */
export function itemSize(n: BomNode | undefined, ctx?: BomCtx): { w: number | null; h: number | null; d: number | null } {
  if (!n) return { w: null, h: null, d: null };
  if (n.kind === "group") {
    const s = asmSize(n, ctx);
    return { w: s?.w ?? null, h: s?.h ?? null, d: s?.d ?? null };
  }
  const p = nodeIdentity(n, ctx).part;
  const d = partDims(p);
  const w = p?.mech.dinWidthMm != null ? p.mech.dinWidthMm + (p.mech.addXMm ?? 0) : d.x;
  return { w, h: d.y, d: d.z };
}
/** Default drawing size when a part has no dimensions yet. */
export const UNKNOWN_W = 18;
export const UNKNOWN_H = 60;

export function asmSize(n: BomNode, ctx?: BomCtx): { w: number; h: number; d: number | null } | null {
  const l = n.layout;
  if (!l) return null;
  let d = l.depthMm;
  if (d == null) {
    for (const it of l.items) {
      const s = itemSize(findNode([n], it.nodeId)?.node, ctx);
      if (s.d != null) d = Math.max(d ?? 0, s.d + (it.railId ? 7.5 : 0));
    }
  }
  return { w: l.widthMm, h: l.heightMm, d };
}

const widthOf = (group: BomNode, nodeId: string, ctx?: BomCtx) => itemSize(findNode([group], nodeId)?.node, ctx).w ?? UNKNOWN_W;
/** Members of an array, left to right. */
export function arrayMembers(l: AsmLayout, arrId: string): AsmItem[] {
  return l.items.filter((i) => i.arr === arrId).sort((a, b) => a.x - b.x);
}
/** Spacing kept before (l) and after (r) an item: arrays only (between pieces, left end, right end). */
export function itemPad(l: AsmLayout, it: AsmItem): { l: number; r: number } {
  const a = it.arr ? l.arrays?.find((x) => x.id === it.arr) : undefined;
  if (!a) return { l: 0, r: 0 };
  const m = arrayMembers(l, a.id);
  const i = m.findIndex((x) => x.id === it.id);
  return { l: i === 0 && a.useLeft ? a.left : 0, r: i === m.length - 1 ? (a.useRight ? a.right : 0) : a.gap };
}
const railKey = (railId: string, side: AsmSide) => (side === "rear" ? `${railId}|rear` : railId);
/** Rail use: total item width (spacing included) against rail length. Keys: rail id (front), "<rail id>|rear" (rear). */
export function railUsage(l: AsmLayout, group: BomNode, ctx?: BomCtx): Map<string, { used: number; length: number; unknown: number }> {
  const m = new Map<string, { used: number; length: number; unknown: number }>();
  for (const r of l.rails) {
    m.set(r.id, { used: 0, length: r.length, unknown: 0 });
    if (hasRear(l)) m.set(railKey(r.id, "rear"), { used: 0, length: r.length, unknown: 0 });
  }
  for (const it of l.items) {
    if (!it.railId) continue;
    const u = m.get(railKey(it.railId, sideOf(it)));
    if (!u) continue;
    const s = itemSize(findNode([group], it.nodeId)?.node, ctx);
    if (s.w == null) u.unknown++;
    const p = itemPad(l, it);
    u.used += (s.w ?? UNKNOWN_W) + p.l + p.r;
  }
  return m;
}

/** Close the gaps on a rail (one side): items keep their order and are packed from the rail start, array spacing kept. */
export function packRail(l: AsmLayout, railId: string, group: BomNode, ctx?: BomCtx, side: AsmSide = "front"): AsmLayout {
  const rail = l.rails.find((r) => r.id === railId);
  if (!rail) return l;
  let x = rail.x;
  const on = l.items.filter((i) => i.railId === railId && sideOf(i) === side).sort((a, b) => a.x - b.x);
  const pos = new Map<string, number>();
  for (const it of on) {
    const p = itemPad(l, it);
    x += p.l;
    pos.set(it.id, x);
    x += widthOf(group, it.nodeId, ctx) + p.r;
  }
  return { ...l, items: l.items.map((i) => (pos.has(i.id) ? { ...i, x: pos.get(i.id)! } : i)) };
}
/** Pack every rail on every side. */
export function packAll(l: AsmLayout, group: BomNode, ctx?: BomCtx): AsmLayout {
  const sides: AsmSide[] = hasRear(l) ? ["front", "rear"] : ["front"];
  return l.rails.reduce((a, r) => sides.reduce((b, s) => packRail(b, r.id, group, ctx, s), a), l);
}

/**
 * Turn an item into an array of `spec.n` pieces (or resize / respace an existing one). New pieces take the instances in
 * `insts` (unplaced units of the line first; the caller may add numbers past the quantity, flagged by the checks).
 * Pieces are laid out from the first one with the spacing; n = 1 dissolves the array.
 */
export function applyArray(l: AsmLayout, itemId: string, spec: Omit<AsmArray, "id">, w: number, insts: number[]): AsmLayout {
  const it = l.items.find((i) => i.id === itemId);
  if (!it) return l;
  const old = it.arr ? arrayMembers(l, it.arr) : [it];
  const first = old[0];
  const n = Math.max(1, Math.round(spec.n));
  if (n === 1) {
    const keep = new Set([first.id]);
    return {
      ...l,
      arrays: (l.arrays ?? []).filter((a) => a.id !== it.arr),
      items: l.items.filter((i) => !old.some((o) => o.id === i.id) || keep.has(i.id)).map((i) => (i.id === first.id ? { ...i, arr: undefined } : i)),
    };
  }
  const id = it.arr ?? newId();
  const members = old.slice(0, n);
  const free = insts.slice();
  while (members.length < n) {
    const inst = free.shift();
    if (inst == null) break;
    members.push({ id: newId(), nodeId: first.nodeId, inst, railId: first.railId, x: 0, y: first.y, ...(first.side ? { side: first.side } : {}), arr: id });
  }
  let x = first.x;
  const placed = members.map((m, i) => {
    const out = { ...m, arr: id, railId: first.railId, y: first.y, x, ...(first.side ? { side: first.side } : {}) };
    x += w + (i < members.length - 1 ? spec.gap : 0);
    return out;
  });
  const drop = new Set(old.map((o) => o.id));
  const arrays = [...(l.arrays ?? []).filter((a) => a.id !== id), { ...spec, id, n: placed.length }];
  return { ...l, arrays, items: [...l.items.filter((i) => !drop.has(i.id)), ...placed] };
}

/** Place every unplaced device in BOM order, filling the front rails left to right and moving to the next rail when one is full. */
export function autoArrange(l: AsmLayout, group: BomNode, ctx?: BomCtx): AsmLayout {
  const placed = new Set(l.items.map((i) => `${i.nodeId}#${i.inst}`));
  const items = l.items.slice();
  const rails = l.rails.slice().sort((a, b) => a.y - b.y);
  const end = new Map(rails.map((r) => [r.id, r.x]));
  for (const it of items) {
    if (!it.railId || sideOf(it) !== "front") continue;
    const w = widthOf(group, it.nodeId, ctx) + itemPad(l, it).r;
    end.set(it.railId, Math.max(end.get(it.railId) ?? 0, it.x + w));
  }
  let ri = 0;
  for (const u of unitsOf(group, ctx)) {
    if (placed.has(`${u.node.id}#${u.inst}`)) continue;
    const w = itemSize(u.node, ctx).w ?? UNKNOWN_W;
    while (ri < rails.length && (end.get(rails[ri].id) ?? 0) + w > rails[ri].x + rails[ri].length + 0.01) ri++;
    const rail = rails[Math.min(ri, rails.length - 1)];
    if (!rail) break;
    const x = end.get(rail.id) ?? rail.x;
    items.push({ id: newId(), nodeId: u.node.id, inst: u.inst, railId: rail.id, x, y: 0 });
    end.set(rail.id, x + w);
  }
  return { ...l, items };
}

export function asmIssues(l: AsmLayout, group: BomNode, ctx?: BomCtx): MechIssue[] {
  const out: MechIssue[] = [];
  const use = railUsage(l, group, ctx);
  const sides: AsmSide[] = hasRear(l) ? ["front", "rear"] : ["front"];
  l.rails.forEach((r, i) => {
    for (const side of sides) {
      const u = use.get(railKey(r.id, side))!;
      const nm = `Rail ${i + 1}${hasRear(l) ? ` (${side})` : ""}`;
      if (u.used > u.length + 0.01) out.push({ level: "error", msg: `${nm}: ${u.used.toFixed(1)} mm of devices on ${u.length} mm` });
      if (u.unknown) out.push({ level: "warn", msg: `${nm}: ${u.unknown} device(s) without a DIN width (drawn ${UNKNOWN_W} mm)` });
    }
    if (l.mount !== "rail" && (r.x < 0 || r.x + r.length > l.widthMm + 0.01)) out.push({ level: "warn", msg: `Rail ${i + 1} extends past the plate` });
  });
  const byRail = new Map<string, AsmItem[]>();
  for (const it of l.items) if (it.railId) byRail.set(railKey(it.railId, sideOf(it)), [...(byRail.get(railKey(it.railId, sideOf(it))) ?? []), it]);
  for (const [rk, list] of byRail) {
    const rail = l.rails.find((r) => r.id === rk.split("|")[0]);
    const s = list.slice().sort((a, b) => a.x - b.x);
    for (let i = 0; i < s.length; i++) {
      const n = findNode([group], s[i].nodeId)?.node;
      if (!n) {
        out.push({ level: "error", id: s[i].id, msg: "Placed device is no longer in the assembly" });
        continue;
      }
      const w = itemSize(n, ctx).w ?? UNKNOWN_W;
      const nm = n.tags[s[i].inst] || nodeIdentity(n, ctx).partNumber;
      if (i + 1 < s.length) {
        const gap = itemPad(l, s[i]).r + itemPad(l, s[i + 1]).l;
        if (s[i].x + w > s[i + 1].x + 0.01) out.push({ level: "error", id: s[i + 1].id, msg: `${nm} overlaps the next device` });
        else if (s[i].x + w + gap > s[i + 1].x + 0.005) out.push({ level: "warn", id: s[i + 1].id, msg: `${nm}: array spacing not kept (Pack rails restores it)` });
      }
      if (rail && (s[i].x < rail.x - 0.01 || s[i].x + w > rail.x + rail.length + 0.01)) out.push({ level: "error", id: s[i].id, msg: `${nm} is off the rail` });
    }
  }
  const all = unitsOf(group, ctx);
  const total = all.length;
  const known = new Set(all.map((u) => `${u.node.id}#${u.inst}`));
  const keys = l.items.map((i) => `${i.nodeId}#${i.inst}`);
  const placedSet = new Set(keys.filter((k) => known.has(k)));
  const extra = l.items.filter((i) => !known.has(`${i.nodeId}#${i.inst}`) && findNode([group], i.nodeId));
  for (const it of extra) out.push({ level: "warn", id: it.id, msg: `${nodeIdentity(findNode([group], it.nodeId)!.node, ctx).partNumber}: more placed than the line quantity` });
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) out.push({ level: "error", msg: `${dup.length} device(s) placed twice` });
  if (placedSet.size < total) out.push({ level: "warn", msg: `${total - placedSet.size} of ${total} devices not placed` });
  return out;
}

// ───────────────────────── field network enclosure ─────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface FneSize {
  key: string;
  label: string;
  enclosure: { w: number; h: number; d: number };
  /** Usable back-panel size (the mounting real estate). */
  panel: { w: number; h: number };
  enclosurePn: string;
  panelPn: string;
}
const i2m = (v: number) => Math.round(v * IN_MM * 100) / 100;
/** Standard Fractal FNE sizes (Saginaw single-door): the back panel is the mounting area. Editable per project / in presets. */
export const FNE_SIZES: FneSize[] = [
  { key: "S", label: "Small 24×24×16 in", enclosure: { w: i2m(24), h: i2m(24), d: i2m(16) }, panel: { w: i2m(20.94), h: i2m(20.94) }, enclosurePn: "SCE-24EL2416LP", panelPn: "SCE-24P24" },
  { key: "M", label: "Medium 36×36×16 in", enclosure: { w: i2m(36), h: i2m(36), d: i2m(16) }, panel: { w: i2m(32.94), h: i2m(32.94) }, enclosurePn: "SCE-36EL3616LP", panelPn: "SCE-36P36" },
  { key: "L", label: "Large 72×36×16 in", enclosure: { w: i2m(36), h: i2m(72), d: i2m(16) }, panel: { w: i2m(32.94), h: i2m(68.94) }, enclosurePn: "SCE-72EL3616LP", panelPn: "SCE-72P36" },
];

export interface Duct extends Rect {
  id: string;
}
export interface Conduit {
  id: string;
  label: string;
  side: "bottom" | "top" | "left" | "right";
  /** Centre position along the side, mm from the enclosure's left (top/bottom) or top (left/right) edge. */
  pos: number;
  /** Outside diameter (mm). */
  dia: number;
  /** Keep-out reserved on the back panel from that side (mm; 0 = none). */
  keepOut: number;
}
/** A DIN-rail assembly (or device) placed in the free zone that contains the anchor point. */
export interface ZonePlacement {
  id: string;
  nodeId: string;
  inst: number;
  /** Anchor point inside the zone (panel coordinates); the zone is found from it when ducts change. */
  px: number;
  py: number;
  /** Offset from the zone centre. */
  offX: number;
  offY: number;
  /** Clearance required around the item (x each side, y each side, z in front). */
  clrX: number;
  clrY: number;
  clrZ: number;
  /** Device IDs of the assembly's linked BOM items (see RackSlot.devs). */
  devs?: DeviceId[] | null;
  labels?: PartLabel[] | null;
  showText?: boolean;
}
export interface FneItem {
  id: string;
  nodeId: string;
  inst: number;
  /** Top-left on the panel (mm). */
  x: number;
  y: number;
  rot?: 0 | 90;
  /** Device tag chosen for this unit (see RackSlot.pin). */
  pin?: { id: string; inst: number } | null;
  /** Device ID defined in Mechanical Design (see RackSlot.dev). */
  dev?: DeviceId | null;
  devs?: DeviceId[] | null;
  labels?: PartLabel[] | null;
  showText?: boolean;
}
export interface FneLayout {
  size: string;
  enclosure: { w: number; h: number; d: number };
  panel: { w: number; h: number };
  enclosureNodeId?: string | null;
  panelNodeId?: string | null;
  /** Depth lost behind the panel (standoff + panel thickness); available depth = enclosure depth − this. */
  backMm: number;
  ductW: number;
  ductPreset: string;
  ducts: Duct[];
  conduitPreset: string;
  conduits: Conduit[];
  zones: ZonePlacement[];
  items: FneItem[];
}

export const DUCT_PRESETS: [string, string][] = [
  ["frame", "Frame (top, bottom, sides)"],
  ["frame1", "Frame + 1 horizontal"],
  ["frame2", "Frame + 2 horizontal (3 rows)"],
  ["sides1", "Sides + 1 horizontal"],
  ["none", "No wire duct"],
];
/** Wire-duct layout on a panel; ducts are `w` wide (2.25 in Panduit by default). */
export function ductPreset(name: string, panel: { w: number; h: number }, w = 57.15, margin = 0): Duct[] {
  const P = panel;
  const d = (x: number, y: number, ww: number, hh: number): Duct => ({ id: newId(), x, y, w: ww, h: hh });
  const sides = [d(margin, margin, w, P.h - 2 * margin), d(P.w - margin - w, margin, w, P.h - 2 * margin)];
  const inner = { x: margin + w, w: P.w - 2 * margin - 2 * w };
  const hz = (yc: number) => d(inner.x, yc - w / 2, inner.w, w);
  const frameH = [d(inner.x, margin, inner.w, w), d(inner.x, P.h - margin - w, inner.w, w)];
  switch (name) {
    case "none": return [];
    case "frame": return [...sides, ...frameH];
    case "frame1": return [...sides, ...frameH, hz(P.h / 2)];
    case "frame2": return [...sides, ...frameH, hz(P.h / 3), hz((2 * P.h) / 3)];
    case "sides1": return [...sides, hz(P.h / 2)];
    default: return [...sides, ...frameH];
  }
}
/** Conduit-entry presets (bottom entry, as on the Librillo FNE: fiber in, fiber out, power). */
export const CONDUIT_PRESETS: [string, string][] = [
  ["b3", "Bottom: fiber in · fiber out · power"],
  ["b2", "Bottom: fiber · power"],
  ["b4", "Bottom: fiber in · fiber out · power · I/O"],
  ["none", "None"],
];
export function conduitPreset(name: string, enc: { w: number; h: number }, dia = 33.4): Conduit[] {
  const mk = (label: string, f: number): Conduit => ({ id: newId(), label, side: "bottom", pos: Math.round(enc.w * f), dia, keepOut: 0 });
  switch (name) {
    case "b2": return [mk("FIBER", 0.35), mk("POWER", 0.65)];
    case "b3": return [mk("FIBER IN", 0.3), mk("FIBER OUT", 0.45), mk("POWER", 0.7)];
    case "b4": return [mk("FIBER IN", 0.25), mk("FIBER OUT", 0.4), mk("POWER", 0.6), mk("I/O", 0.75)];
    default: return [];
  }
}

export function emptyFne(size: FneSize = FNE_SIZES[1]): FneLayout {
  return {
    size: size.key, enclosure: { ...size.enclosure }, panel: { ...size.panel }, enclosureNodeId: null, panelNodeId: null, backMm: 25,
    ductW: 57.15, ductPreset: "frame2", ducts: ductPreset("frame2", size.panel), conduitPreset: "b3", conduits: conduitPreset("b3", size.enclosure), zones: [], items: [],
  };
}

/** Panel offset inside the enclosure (panel centred). */
export const panelOffset = (f: FneLayout) => ({ x: (f.enclosure.w - f.panel.w) / 2, y: (f.enclosure.h - f.panel.h) / 2 });

/** Conduit keep-outs as panel rectangles. */
export function conduitKeepOuts(f: FneLayout): Rect[] {
  const o = panelOffset(f);
  return f.conduits
    .filter((c) => c.keepOut > 0)
    .map((c) => {
      const half = c.dia / 2 + 10;
      if (c.side === "bottom") return { x: c.pos - o.x - half, y: f.panel.h - c.keepOut, w: 2 * half, h: c.keepOut };
      if (c.side === "top") return { x: c.pos - o.x - half, y: 0, w: 2 * half, h: c.keepOut };
      if (c.side === "left") return { x: 0, y: c.pos - o.y - half, w: c.keepOut, h: 2 * half };
      return { x: f.panel.w - c.keepOut, y: c.pos - o.y - half, w: c.keepOut, h: 2 * half };
    });
}

/**
 * Free zones of the panel: the area left by wire ducts (and conduit keep-outs), as maximal rows.
 * Grid decomposition on every obstacle edge, free cells merged into horizontal runs, then runs with
 * the same x-range merged vertically. Zones smaller than `min` mm are dropped.
 */
export function freeZones(f: Pick<FneLayout, "panel" | "ducts"> & Partial<FneLayout>, min = 30): Rect[] {
  const P = f.panel;
  const obs: Rect[] = [...f.ducts, ...(f.conduits && f.enclosure ? conduitKeepOuts(f as FneLayout) : [])]
    .map((r) => ({ x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(P.w, r.x + r.w) - Math.max(0, r.x), h: Math.min(P.h, r.y + r.h) - Math.max(0, r.y) }))
    .filter((r) => r.w > 0 && r.h > 0);
  const xs = [...new Set([0, P.w, ...obs.flatMap((r) => [r.x, r.x + r.w])].map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
  const ys = [...new Set([0, P.h, ...obs.flatMap((r) => [r.y, r.y + r.h])].map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
  const blocked = (x0: number, x1: number, y0: number, y1: number) => obs.some((r) => r.x < x1 - 0.01 && r.x + r.w > x0 + 0.01 && r.y < y1 - 0.01 && r.y + r.h > y0 + 0.01);
  // Horizontal runs per grid row.
  let rows: Rect[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    let start: number | null = null;
    for (let i = 0; i + 1 <= xs.length; i++) {
      const free = i + 1 < xs.length && !blocked(xs[i], xs[i + 1], ys[j], ys[j + 1]);
      if (free && start == null) start = xs[i];
      if (!free && start != null) {
        rows.push({ x: start, y: ys[j], w: xs[i] - start, h: ys[j + 1] - ys[j] });
        start = null;
      }
    }
  }
  // Merge vertically adjacent runs with the same x-range.
  rows = rows.sort((a, b) => a.x - b.x || a.y - b.y);
  const merged: Rect[] = [];
  for (const r of rows) {
    const m = merged.find((z) => Math.abs(z.x - r.x) < 0.01 && Math.abs(z.w - r.w) < 0.01 && Math.abs(z.y + z.h - r.y) < 0.01);
    if (m) m.h += r.h;
    else merged.push({ ...r });
  }
  return merged.filter((z) => z.w >= min && z.h >= min).sort((a, b) => a.y - b.y || a.x - b.x);
}
export const zoneAt = (zones: Rect[], x: number, y: number) => zones.find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h);

/** Where an item lands in its zone (centred + offsets) and whether it fits with its clearances (x/y in the zone, z in the depth). */
export function zoneFit(f: FneLayout, zp: ZonePlacement, size: { w: number | null; h: number | null; d: number | null }, zones = freeZones(f)) {
  const z = zoneAt(zones, zp.px, zp.py);
  const w = size.w ?? 0;
  const h = size.h ?? 0;
  if (!z) return { zone: null, x: zp.px - w / 2, y: zp.py - h / 2, w, h, ok: false, msgs: ["The anchor point is not in a free zone (ducts changed?) — drop it into a zone again"] };
  const x = z.x + (z.w - w) / 2 + zp.offX;
  const y = z.y + (z.h - h) / 2 + zp.offY;
  const msgs: string[] = [];
  if (size.w == null || size.h == null) msgs.push("Size unknown (set part dimensions or the assembly plate size)");
  if (x - zp.clrX < z.x - 0.01 || x + w + zp.clrX > z.x + z.w + 0.01) msgs.push(`Needs ${(w + 2 * zp.clrX).toFixed(0)} mm wide with clearance; the zone is ${z.w.toFixed(0)} mm`);
  if (y - zp.clrY < z.y - 0.01 || y + h + zp.clrY > z.y + z.h + 0.01) msgs.push(`Needs ${(h + 2 * zp.clrY).toFixed(0)} mm high with clearance; the zone is ${z.h.toFixed(0)} mm`);
  const avail = f.enclosure.d - f.backMm;
  if (size.d != null && size.d + zp.clrZ > avail + 0.01) msgs.push(`Needs ${(size.d + zp.clrZ).toFixed(0)} mm depth; ${avail.toFixed(0)} mm available`);
  return { zone: z, x, y, w, h, ok: !msgs.length, msgs };
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;

/** Rectangles of everything placed on the panel (zone placements and loose items) with labels, for drawing and checks. */
export function fneBoxes(f: FneLayout, unit: BomNode, ctx?: BomCtx): (Rect & { id: string; nodeId: string; inst: number; kind: "zone" | "item"; d: number | null; msgs: string[] })[] {
  const zones = freeZones(f);
  const out: ReturnType<typeof fneBoxes> = [];
  for (const zp of f.zones) {
    const n = findNode([unit], zp.nodeId)?.node;
    const s = itemSize(n, ctx);
    const r = zoneFit(f, zp, s, zones);
    out.push({ id: zp.id, nodeId: zp.nodeId, inst: zp.inst, kind: "zone", x: r.x, y: r.y, w: r.w || UNKNOWN_W * 4, h: r.h || UNKNOWN_H, d: s.d, msgs: n ? r.msgs : ["No longer in the BOM"] });
  }
  for (const it of f.items) {
    const n = findNode([unit], it.nodeId)?.node;
    const s = itemSize(n, ctx);
    const w = (it.rot === 90 ? s.h : s.w) ?? UNKNOWN_W * 3;
    const h = (it.rot === 90 ? s.w : s.h) ?? UNKNOWN_H;
    const msgs: string[] = n ? [] : ["No longer in the BOM"];
    if (s.w == null || s.h == null) msgs.push("Size unknown (set part dimensions)");
    if (s.d != null && s.d > f.enclosure.d - f.backMm) msgs.push(`${s.d.toFixed(0)} mm deep; ${(f.enclosure.d - f.backMm).toFixed(0)} mm available`);
    out.push({ id: it.id, nodeId: it.nodeId, inst: it.inst, kind: "item", x: it.x, y: it.y, w, h, d: s.d, msgs });
  }
  return out;
}

export function fneIssues(f: FneLayout, unit: BomNode, ctx?: BomCtx): MechIssue[] {
  const out: MechIssue[] = [];
  const boxes = fneBoxes(f, unit, ctx);
  const label = (b: { nodeId: string; inst: number }) => {
    const n = findNode([unit], b.nodeId)?.node;
    return n ? n.tags[b.inst] ? `-${n.tags[b.inst]}` : n.kind === "group" ? n.name || "assembly" : nodeIdentity(n, ctx).partNumber : "?";
  };
  for (const b of boxes) {
    for (const m of b.msgs) out.push({ level: m.startsWith("Size unknown") ? "warn" : "error", id: b.id, msg: `${label(b)}: ${m}` });
    if (b.x < -0.01 || b.y < -0.01 || b.x + b.w > f.panel.w + 0.01 || b.y + b.h > f.panel.h + 0.01) out.push({ level: "error", id: b.id, msg: `${label(b)} is off the back panel` });
    if (b.kind === "item") for (const d of f.ducts) if (overlap(b, d)) out.push({ level: "error", id: b.id, msg: `${label(b)} sits on a wire duct` });
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) out.push({ level: "error", id: boxes[j].id, msg: `${label(boxes[i])} and ${label(boxes[j])} overlap` });
  for (const c of f.conduits) {
    const len = c.side === "bottom" || c.side === "top" ? f.enclosure.w : f.enclosure.h;
    if (c.pos - c.dia / 2 < 0 || c.pos + c.dia / 2 > len) out.push({ level: "error", msg: `Conduit ${c.label} is outside the enclosure side` });
  }
  const cs = f.conduits.slice().sort((a, b) => a.side.localeCompare(b.side) || a.pos - b.pos);
  for (let i = 1; i < cs.length; i++) if (cs[i].side === cs[i - 1].side && cs[i].pos - cs[i - 1].pos < (cs[i].dia + cs[i - 1].dia) / 2 + 12) out.push({ level: "warn", msg: `Conduits ${cs[i - 1].label} and ${cs[i].label} are closer than 12 mm (wall to wall)` });
  return out;
}

/** Groups of a unit that can go in an FNE zone (assemblies with a layout first) and loose devices for panel mounting. */
export function fneCandidates(unit: BomNode, ctx?: BomCtx) {
  const asm: BomNode[] = [];
  const loose: BomNode[] = [];
  walk(unit.children, (n, parents) => {
    if (parents.some((p) => p.layout)) return;
    if (n.kind === "group" && n.layout) asm.push(n);
    else if (n.kind === "part") {
      const p = nodeIdentity(n, ctx).part;
      if (!p || p.mech.mount === "none" || p.mech.mount === "floor" || p.mech.mount === "rack") return;
      // Unclassified parts without dimensions (cables, accessories) are not offered for panel mounting.
      if (!p.mech.mount && p.mech.widthMm == null && p.mech.heightMm == null) return;
      loose.push(n);
    }
  });
  const rank = (n: BomNode) => ({ panel: 0, wall: 1, din: 2 } as Record<string, number>)[nodeIdentity(n, ctx).part?.mech.mount ?? ""] ?? 3;
  return { asm, loose: loose.sort((a, b) => rank(a) - rank(b)) };
}

// ───────────────────────── DXF export ─────────────────────────

export type DxfShape =
  | { t: "rect"; x: number; y: number; w: number; h: number; layer?: string }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; layer?: string }
  | { t: "circle"; cx: number; cy: number; r: number; layer?: string }
  | { t: "text"; x: number; y: number; h: number; text: string; layer?: string };

/** Minimal ASCII DXF (R12 entities, mm). Input y grows downwards (screen); DXF y grows upwards, so y is flipped. */
export function toDxf(shapes: DxfShape[]): string {
  const maxY = shapes.reduce((m, s) => Math.max(m, s.t === "rect" ? s.y + s.h : s.t === "line" ? Math.max(s.y1, s.y2) : s.t === "circle" ? s.cy + s.r : s.y), 0);
  const Y = (y: number) => +(maxY - y).toFixed(3);
  const X = (x: number) => +x.toFixed(3);
  const L: string[] = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  const line = (x1: number, y1: number, x2: number, y2: number, layer: string) => L.push("0", "LINE", "8", layer, "10", String(X(x1)), "20", String(Y(y1)), "11", String(X(x2)), "21", String(Y(y2)));
  for (const s of shapes) {
    const layer = (s.layer ?? "0").replace(/[^A-Za-z0-9_-]/g, "_");
    if (s.t === "rect") {
      line(s.x, s.y, s.x + s.w, s.y, layer);
      line(s.x + s.w, s.y, s.x + s.w, s.y + s.h, layer);
      line(s.x + s.w, s.y + s.h, s.x, s.y + s.h, layer);
      line(s.x, s.y + s.h, s.x, s.y, layer);
    } else if (s.t === "line") line(s.x1, s.y1, s.x2, s.y2, layer);
    else if (s.t === "circle") L.push("0", "CIRCLE", "8", layer, "10", String(X(s.cx)), "20", String(Y(s.cy)), "40", String(+s.r.toFixed(3)));
    else L.push("0", "TEXT", "8", layer, "10", String(X(s.x)), "20", String(Y(s.y)), "40", String(+s.h.toFixed(3)), "1", s.text.replace(/[\r\n]+/g, " "));
  }
  L.push("0", "ENDSEC", "0", "EOF");
  return L.join("\r\n") + "\r\n";
}

const tagOr = (n: BomNode | undefined, inst: number, ctx?: BomCtx) => (n ? (n.tags[inst] ? `-${n.tags[inst]}` : n.kind === "group" ? n.name : nodeIdentity(n, ctx).partNumber) : "?");

/** Rack elevation as DXF shapes (front and rear side by side). */
export function rackShapes(r: RackLayout, unit: BomNode, ctx?: BomCtx): DxfShape[] {
  const out: DxfShape[] = [];
  const H = r.totalU * U_MM;
  const faces: ("front" | "rear")[] = ["front", "rear"];
  faces.forEach((face, fi) => {
    const ox = fi * (RACK_WIDTH_MM + 200);
    out.push({ t: "rect", x: ox, y: 0, w: RACK_WIDTH_MM, h: H, layer: "RACK" });
    out.push({ t: "text", x: ox, y: H + 40, h: 18, text: `${unit.tags[0] ?? unit.name} - ${face.toUpperCase()} VIEW`, layer: "TEXT" });
    for (let u = 1; u <= r.totalU; u++) {
      out.push({ t: "line", x1: ox - 25, y1: H - u * U_MM, x2: ox, y2: H - u * U_MM, layer: "RACK" });
      out.push({ t: "text", x: ox - 22, y: H - (u - 1) * U_MM - 15, h: 9, text: String(u), layer: "TEXT" });
    }
    for (const s of r.slots.filter((x) => x.face === face || x.fullDepth)) {
      const n = findNode([unit], s.nodeId)?.node;
      const y = H - (s.u + s.h - 1) * U_MM;
      out.push({ t: "rect", x: ox + 16, y, w: RACK_WIDTH_MM - 32, h: s.h * U_MM, layer: "EQUIP" });
      out.push({ t: "text", x: ox + 24, y: y + Math.min(26, s.h * U_MM - 6), h: 10, text: `${tagOr(n, s.inst, ctx)}  ${n ? nodeIdentity(n, ctx).partNumber : ""}`.trim(), layer: "TEXT" });
    }
  });
  return out;
}

/** FNE back panel (with enclosure outline, ducts, conduits, zones and items) as DXF shapes. */
export function fneShapes(f: FneLayout, unit: BomNode, ctx?: BomCtx): DxfShape[] {
  const o = panelOffset(f);
  const out: DxfShape[] = [
    { t: "rect", x: 0, y: 0, w: f.enclosure.w, h: f.enclosure.h, layer: "ENCLOSURE" },
    { t: "rect", x: o.x, y: o.y, w: f.panel.w, h: f.panel.h, layer: "PANEL" },
  ];
  for (const d of f.ducts) out.push({ t: "rect", x: o.x + d.x, y: o.y + d.y, w: d.w, h: d.h, layer: "DUCT" });
  for (const c of f.conduits) {
    const cx = c.side === "left" ? 0 : c.side === "right" ? f.enclosure.w : c.pos;
    const cy = c.side === "top" ? 0 : c.side === "bottom" ? f.enclosure.h : c.pos;
    out.push({ t: "circle", cx, cy, r: c.dia / 2, layer: "CONDUIT" }, { t: "text", x: cx - c.dia / 2, y: cy + c.dia / 2 + 14, h: 8, text: c.label, layer: "TEXT" });
  }
  for (const b of fneBoxes(f, unit, ctx)) {
    const n = findNode([unit], b.nodeId)?.node;
    out.push({ t: "rect", x: o.x + b.x, y: o.y + b.y, w: b.w, h: b.h, layer: b.kind === "zone" ? "ASSEMBLY" : "EQUIP" });
    out.push({ t: "text", x: o.x + b.x + 4, y: o.y + b.y + 14, h: 9, text: tagOr(n, b.inst, ctx), layer: "TEXT" });
  }
  out.push({ t: "text", x: 0, y: f.enclosure.h + 60, h: 16, text: `${unit.tags[0] ?? unit.name} - BACK PANEL ${f.panel.w.toFixed(1)} x ${f.panel.h.toFixed(1)} mm`, layer: "TEXT" });
  return out;
}

/** Assembly plate with rails and devices as DXF shapes. */
export function asmShapes(l: AsmLayout, group: BomNode, ctx?: BomCtx): DxfShape[] {
  const out: DxfShape[] = [];
  const sides: AsmSide[] = hasRear(l) ? ["front", "rear"] : ["front"];
  for (const side of sides) {
    const dy = sideDy(l, side);
    if (l.mount !== "rail") out.push({ t: "rect", x: 0, y: dy, w: l.widthMm, h: l.heightMm, layer: "PLATE" });
    if (hasRear(l)) out.push({ t: "text", x: 0, y: dy - 4, h: 5, text: side === "rear" ? "REAR" : "FRONT", layer: "TEXT" });
    for (const r of l.rails) out.push({ t: "rect", x: r.x, y: dy + r.y - DIN_RAIL_H / 2, w: r.length, h: DIN_RAIL_H, layer: l.mount === "rail" ? "RAIL_REF" : "DINRAIL" });
    for (const it of l.items) {
      if (sideOf(it) !== side) continue;
      const n = findNode([group], it.nodeId)?.node;
      const s = itemSize(n, ctx);
      const w = s.w ?? UNKNOWN_W;
      const h = s.h ?? UNKNOWN_H;
      const rail = l.rails.find((r) => r.id === it.railId);
      const y = dy + (rail ? rail.y - h / 2 : it.y);
      out.push({ t: "rect", x: it.x, y, w, h, layer: "EQUIP" }, { t: "text", x: it.x + 1, y: y - 3, h: 4, text: tagOr(n, it.inst, ctx), layer: "TEXT" });
    }
  }
  return out;
}

/** Centre of a part-line balloon of radius r (index k shifts it sideways so several at one position don't overlap). */
export function labelAnchor(box: { x: number; y: number; w: number; h: number }, pos: LabelPos, out: boolean, r: number, k = 0, ry = r): { x: number; y: number } {
  const g = 2;
  const d = (out ? 1 : -1) * (r + g);
  const dy = (out ? 1 : -1) * (ry + g);
  const left = pos === "TL" || pos === "L" || pos === "BL";
  const right = pos === "TR" || pos === "R" || pos === "BR";
  const top = pos === "TL" || pos === "T" || pos === "TR";
  const bottom = pos === "BL" || pos === "B" || pos === "BR";
  let x = left ? box.x - d : right ? box.x + box.w + d : box.x + box.w / 2;
  let y = top ? box.y - dy : bottom ? box.y + box.h + dy : box.y + box.h / 2;
  // Corners outside sit diagonally; inside they sit in the corner.
  if (!out && !left && !right) x = box.x + box.w / 2;
  if (!out && !top && !bottom) y = box.y + box.h / 2;
  const step = (2 * r + g) * k;
  if (left || (!right && !left)) x += left ? (out ? -step : step) : step;
  else x -= out ? -step : step;
  return { x, y };
}
