/**
 * Mechanical layouts as their own documents: the equipment tree comes from the master parts (imported once from a project
 * BOM unit, then edited freely); a saved project BOM version is only an overlay that supplies device tags and quantities.
 *   red    — layout line no longer found on the referenced BOM
 *   yellow — fewer placed (or listed) than the BOM quantity
 */
import { cloneNode, deviceTag, findNode, nodeIdentity, walk, type BomCtx, type BomNode } from "./bom.js";
import { devsOf, emptyFne, emptyRack, type DeviceId, type FneLayout, type RackLayout } from "./mech.js";

export interface MechRef {
  projectId: string;
  projectName: string;
  /** null = follow the latest version. */
  major: number | null;
  minor: number | null;
  unitId: string;
  unitLabel: string;
}
export type TagDisplay = "pn" | "tag" | "both";
export interface MechLayoutDoc {
  kind: "rack" | "fne";
  /** Equipment tree of the layout (root = the rack / enclosure; carries .rack or .fne). */
  unit: BomNode;
  ref: MechRef | null;
  display: TagDisplay;
  /** Assembly-description format (left / right text of each device), imported from the library and editable per layout. */
  desc?: { from: { id: string; name: string; major: number; minor: number } | null; fmt: import("./pnformat.js").AsmDescFormat } | null;
}

export function newLayoutDoc(kind: "rack" | "fne", name: string): MechLayoutDoc {
  const unit: BomNode = { id: cryptoId(), kind: "group", name, qty: 1, tags: [], children: [], role: "loc" };
  if (kind === "rack") unit.rack = emptyRack(42);
  else unit.fne = emptyFne();
  return { kind, unit, ref: null, display: "both" };
}
const cryptoId = () => (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ?? `m${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** Copy a BOM unit into a layout: fresh ids, each line remembers its BOM node and is linked to it. Rack / FNE layouts already on the unit come along. */
export function importUnit(bomUnit: BomNode, kind: "rack" | "fne"): BomNode {
  const ids: string[] = [];
  walk([bomUnit], (n) => ids.push(n.id));
  const c = cloneNode(bomUnit);
  const out: string[] = [];
  walk([c], (n) => out.push(n.id));
  const map = new Map(out.map((id, i) => [id, ids[i]]));
  const mark = (n: BomNode): BomNode => {
    const src = map.get(n.id)!;
    return { ...n, bomNodeId: src, links: [src], children: n.children.map(mark) };
  };
  const u = mark(c);
  if (kind === "rack" && !u.rack) u.rack = emptyRack(42);
  if (kind === "fne" && !u.fne) u.fne = emptyFne();
  return u;
}

/** Quantity of a BOM node per unit instance (product of quantities from the unit down). */
function perUnitQty(unit: BomNode, id: string): number {
  const hit = findNode([unit], id);
  if (!hit) return 0;
  return hit.parents.slice(1).reduce((m, p) => m * (p.qty || 1), 1) * (hit.node.qty || 0);
}

export interface Overlay {
  /** Layout node → status. */
  status: Map<string, "ok" | "missing" | "short">;
  /** Layout node → BOM quantity of its links (parts) per unit instance. */
  bomQty: Map<string, number>;
  /** Layout node → placed count. */
  placed: Map<string, number>;
  /** BOM part lines of the unit not represented in the layout (or under-represented): BOM node id → missing qty. */
  notInLayout: { node: BomNode; missing: number }[];
  /** Device tags shown for a placed unit of a layout line (a pinned BOM line / tag wins). */
  tags: (layoutNodeId: string, inst: number, pin?: { id: string; inst: number } | null) => string[];
  /** BOM lines of the referenced unit with the same master part as a layout line (to pin a device tag). */
  choices: (layoutNodeId: string) => { node: BomNode; tags: string[] }[];
  hasRef: boolean;
}

/** Placed instances per layout node (rack slots, FNE zones and items). */
export function placedCounts(layoutUnit: BomNode, rack?: RackLayout | null, fne?: FneLayout | null): Map<string, number> {
  const m = new Map<string, Set<number>>();
  const add = (id: string, inst: number) => (m.get(id) ?? m.set(id, new Set()).get(id)!).add(inst);
  rack?.slots.forEach((s) => add(s.nodeId, s.inst));
  fne?.zones.forEach((z) => add(z.nodeId, z.inst));
  fne?.items.forEach((i) => add(i.nodeId, i.inst));
  // The cabinet of a rack and the enclosure / back panel of an FNE are the layout itself.
  if (rack?.cabinetNodeId) add(rack.cabinetNodeId, 0);
  if (fne?.enclosureNodeId) add(fne.enclosureNodeId, 0);
  if (fne?.panelNodeId) add(fne.panelNodeId, 0);
  // Lines inside a placed assembly count as placed with it.
  const out = new Map([...m].map(([k, v]) => [k, v.size]));
  walk([layoutUnit], (n) => {
    if (n.kind === "group" && out.get(n.id)) walk(n.children, (c) => out.set(c.id, Math.max(out.get(c.id) ?? 0, Math.round(c.qty || 0) * (out.get(n.id) ?? 0))));
  });
  return out;
}

/** BOM nodes a layout line stands for: its links still on the BOM, else the BOM line with the same master part. */
export function resolveLinks(n: BomNode, bomUnit: BomNode, used?: Set<string>): string[] {
  const links = (n.links ?? []).filter((id) => findNode([bomUnit], id));
  if (links.length || n.kind !== "part" || !n.partId) return links;
  let match: BomNode | undefined;
  // Prefer a BOM line no other layout line has taken (several lines of the same part).
  walk(bomUnit.children, (b) => !match && b.kind === "part" && b.partId === n.partId && !used?.has(b.id) && (match = b));
  if (!match) walk(bomUnit.children, (b) => !match && b.kind === "part" && b.partId === n.partId && (match = b));
  return match ? [match.id] : [];
}

export function computeOverlay(layoutUnit: BomNode, bomUnit: BomNode | null, ctx?: BomCtx): Overlay {
  const status = new Map<string, "ok" | "missing" | "short">();
  const bomQty = new Map<string, number>();
  const placed = placedCounts(layoutUnit, layoutUnit.rack, layoutUnit.fne);
  if (!bomUnit) return { status, bomQty, placed, notInLayout: [], tags: () => [], choices: () => [], hasRef: false };
  const covered = new Map<string, number>();
  const resolved = new Map<string, string[]>();
  const used = new Set<string>();
  walk(layoutUnit.children, (n) => {
    const links = resolveLinks(n, bomUnit, used);
    links.forEach((id) => used.add(id));
    resolved.set(n.id, links);
    if (!links.length) {
      status.set(n.id, "missing");
      return;
    }
    const q = links.reduce((s, id) => s + (findNode([bomUnit], id)!.node.kind === "part" ? perUnitQty(bomUnit, id) : 0), 0);
    bomQty.set(n.id, q);
    const has = Math.max(placed.get(n.id) ?? 0, 0);
    links.forEach((id) => covered.set(id, (covered.get(id) ?? 0) + Math.round(n.qty || 0)));
    const placeable = n.kind === "group" ? !!n.layout : true;
    status.set(n.id, placeable && q > 0 && has < q ? "short" : "ok");
  });
  const notInLayout: Overlay["notInLayout"] = [];
  walk(bomUnit.children, (b) => {
    if (b.kind !== "part") return;
    if (ctx && nodeIdentity(b, ctx).part?.mech.mount === "none") return;
    const need = perUnitQty(bomUnit, b.id);
    const have = covered.get(b.id) ?? 0;
    if (have < need) notInLayout.push({ node: b, missing: need - have });
  });
  const ownTags = (id: string) => {
    const hit = findNode([bomUnit], id);
    if (!hit) return [];
    return hit.node.tags.length ? hit.node.tags : [...hit.parents.slice(1)].reverse().find((p) => p.tags.length)?.tags ?? [];
  };
  const choices = (layoutNodeId: string) => {
    const n = findNode([layoutUnit], layoutNodeId)?.node;
    if (!n) return [];
    const out: { node: BomNode; tags: string[] }[] = [];
    const pid = n.kind === "part" ? n.partId : null;
    const pn = ctx && n.kind === "part" ? nodeIdentity(n, ctx).partNumber.trim().toLowerCase() : "";
    walk(bomUnit.children, (b) => {
      if (b.kind !== "part") return;
      const same = (pid && b.partId === pid) || (pn && ctx && nodeIdentity(b, ctx).partNumber.trim().toLowerCase() === pn) || (resolved.get(n.id) ?? []).includes(b.id);
      if (same) out.push({ node: b, tags: ownTags(b.id) });
    });
    return out;
  };
  const tags = (layoutNodeId: string, inst: number, pin?: { id: string; inst: number } | null) => {
    if (pin && findNode([bomUnit], pin.id)) {
      const t = ownTags(pin.id)[pin.inst];
      if (t) return [`-${t}`];
    }
    const n = findNode([layoutUnit], layoutNodeId)?.node;
    if (!n) return [];
    const links = resolved.get(n.id) ?? resolveLinks(n, bomUnit);
    const out: string[] = [];
    for (const id of links) {
      const hit = findNode([bomUnit], id);
      if (!hit) continue;
      const b = hit.node;
      // A line without its own tags shows the tag of its nearest tagged parent below the unit (e.g. the sub-assembly).
      const own = b.tags.length ? b.tags : [...hit.parents.slice(1)].reverse().find((p) => p.tags.length)?.tags ?? [];
      if (b.kind === "part") {
        if (own[inst] && (links.length === 1 || own.length === Math.round(n.qty || 0))) out.push(`-${own[inst]}`);
        else out.push(...own.map((t) => `-${t}`));
      } else if (own.length) out.push(...own.map((t) => `-${t}`));
      else if (b.alias || b.name) out.push(b.alias || b.name);
    }
    return [...new Set(out)];
  };
  return { status, bomQty, placed, notInLayout, tags, choices, hasRef: true };
}

/**
 * Units placed in mechanical layouts per BOM line of one project unit (Parts & BOM "Mech" column): every layout that
 * references the unit adds the placed count of its lines, mapped to the BOM lines they stand for.
 */
export function placedByBom(layouts: MechLayoutDoc[], bomUnit: BomNode): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of layouts) {
    const placed = placedCounts(l.unit, l.unit.rack, l.unit.fne);
    const used = new Set<string>();
    walk(l.unit.children, (n) => {
      const links = resolveLinks(n, bomUnit, used);
      links.forEach((id) => used.add(id));
      const p = placed.get(n.id) ?? 0;
      if (!p) return;
      const parts = links.filter((id) => findNode([bomUnit], id)?.node.kind === "part");
      // A placed line linked to several BOM lines fills them in order.
      let left = p;
      for (const id of parts) {
        const need = perUnitQty(bomUnit, id) - (out.get(id) ?? 0);
        const take = parts.length === 1 ? left : Math.max(0, Math.min(left, need));
        out.set(id, (out.get(id) ?? 0) + take);
        left -= take;
      }
    });
  }
  return out;
}
export { perUnitQty };

/** The unit of a project BOM a reference points to (by id, else by its first tag). */
export function refUnit(units: BomNode[], ref: MechRef | null): BomNode | null {
  if (!ref) return null;
  return units.find((u) => u.id === ref.unitId) ?? units.find((u) => (u.tags[0] || u.name) === ref.unitLabel) ?? null;
}

export interface DeviceEntry {
  bomId: string;
  num: string;
  /** Prefix + number (no role sign). */
  tag: string;
  layout: string;
  layoutNodeId: string;
  /** Rack slot / FNE item id. */
  placeId: string;
}
/** Every device ID defined in the given layouts (rack slots and FNE panel items with a number). */
export function deviceIds(layouts: { name: string; doc: MechLayoutDoc }[], prefixOf: (bomId: string) => string): DeviceEntry[] {
  const out: DeviceEntry[] = [];
  for (const { name, doc } of layouts) {
    const add = (p: { id: string; nodeId: string; dev?: DeviceId | null; devs?: DeviceId[] | null }) => {
      for (const d of devsOf(p)) {
        if (!d.bomId || !d.num.trim()) continue;
        out.push({ bomId: d.bomId, num: d.num.trim(), tag: deviceTag(d.prefix?.trim() || prefixOf(d.bomId), d.num), layout: name, layoutNodeId: p.nodeId, placeId: p.id });
      }
    };
    doc.unit.rack?.slots.forEach(add);
    doc.unit.fne?.items.forEach(add);
    doc.unit.fne?.zones?.forEach(add);
  }
  return out;
}
/** Device tags per BOM line from the layouts (sorted, unique) and the duplicates found. */
export function tagsByBom(entries: DeviceEntry[]): { tags: Map<string, string[]>; dupes: Set<string> } {
  const tags = new Map<string, string[]>();
  const seen = new Map<string, number>();
  for (const e of entries) {
    const k = e.tag.toUpperCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
    const l = tags.get(e.bomId) ?? [];
    if (!l.some((t) => t.toUpperCase() === k)) l.push(e.tag);
    tags.set(e.bomId, l);
  }
  for (const l of tags.values()) l.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { tags, dupes: new Set([...seen].filter(([, c]) => c > 1).map(([k]) => k)) };
}

/**
 * Links to each BOM line from placed layout lines (Parts & BOM "Mech" column of groups and sub-assemblies). Lines only
 * copied into a layout by the import (not placed in a rack / FNE) are not counted.
 */
export function linkCounts(layouts: MechLayoutDoc[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of layouts) {
    const placed = placedCounts(l.unit, l.unit.rack, l.unit.fne);
    walk(l.unit.children, (n) => (placed.get(n.id) ?? 0) > 0 && (n.links ?? []).forEach((id) => out.set(id, (out.get(id) ?? 0) + 1)));
  }
  return out;
}
