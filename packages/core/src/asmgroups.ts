/**
 * Project assembly groups (Mechanical Design → Assemblies → Project BOM groups).
 *
 * A project keeps a set of assembly groups (PDU.01, RMU-A, FNE.01 …). The set is linked to one saved project BOM
 * version; that link is only used to validate quantities (BOM vs. mechanical layout). Each group is composed of BOM
 * groups / sub-assemblies / part lines of the linked BOM (multi-select; e.g. PDU.01 = B1 + B2 on one 4U RMU), plus
 * free extra parts (master parts list, template library) that are not on the BOM.
 */
import { findNode, newId, nodeIdentity, walk, type BomCtx, type BomNode } from "./bom.js";
import { computeOverlay, refUnit, type MechLayoutDoc } from "./mechlayout.js";
import { unitsOf, type AsmLayout } from "./mech.js";

export interface AsmLink {
  projectId: string;
  projectName: string;
  /** null = latest saved version (follows new saves). */
  major: number | null;
  minor: number | null;
}
export interface AsmGroup {
  id: string;
  name: string;
  notes?: string;
  /** Nodes of the linked BOM (groups, sub-assemblies or part lines), in order. */
  sources: string[];
  /** Additions that are not on the BOM: one group node per batch (master parts, a template), shown as its own source. */
  extras: BomNode[];
  layout: AsmLayout | null;
}
export interface AsmSet {
  link: AsmLink | null;
  groups: AsmGroup[];
}
export const emptyAsmSet = (): AsmSet => ({ link: null, groups: [] });
export function newAsmGroup(name: string, over: Partial<AsmGroup> = {}): AsmGroup {
  return { id: newId(), name, sources: [], extras: [], layout: null, ...over };
}

/** Unit (top-level node) of the linked BOM that holds a node. */
export function unitOfNode(units: BomNode[], id: string): BomNode | null {
  for (const u of units) if (u.id === id || findNode(u.children, id)) return u;
  return null;
}

/**
 * The assembly as a BOM tree for the layout editor: a group whose children are the linked BOM sources (as they are in
 * the linked version, ids kept) followed by the extra batches. Sources no longer in the BOM are reported in `missing`.
 */
export function asmGroupRoot(g: AsmGroup, bomUnits: BomNode[]): { root: BomNode; missing: string[] } {
  const missing: string[] = [];
  const kids: BomNode[] = [];
  for (const id of g.sources) {
    const hit = findNode(bomUnits, id);
    if (hit) kids.push(hit.node);
    else missing.push(id);
  }
  return { root: { id: g.id, kind: "group", name: g.name, qty: 1, tags: [], children: [...kids, ...g.extras], layout: g.layout }, missing };
}

export interface AsmCheckRow {
  node: BomNode;
  /** BOM group / sub-assembly / line the row comes from. */
  srcId: string;
  bom: number;
  placed: number;
  status: "ok" | "short" | "over";
}
export interface AsmCheck {
  rows: AsmCheckRow[];
  extras: { node: BomNode; srcId: string; qty: number; placed: number }[];
  missing: string[];
  /** Linked BOM nodes that are also a source of another group (counted twice). */
  shared: { id: string; groups: string[] }[];
  ok: boolean;
}
/** Quantity check of one group against its linked BOM: per part line, BOM quantity vs. placed in the layout (front + rear). */
export function asmCheck(g: AsmGroup, bomUnits: BomNode[], ctx?: BomCtx, all: AsmGroup[] = []): AsmCheck {
  const { root, missing } = asmGroupRoot(g, bomUnits);
  const placed = new Map<string, number>();
  for (const it of g.layout?.items ?? []) placed.set(it.nodeId, (placed.get(it.nodeId) ?? 0) + 1);
  const need = new Map<string, number>();
  for (const u of unitsOf(root, ctx)) need.set(u.node.id, (need.get(u.node.id) ?? 0) + 1);
  const extraIds = new Set<string>();
  walk(g.extras, (n) => extraIds.add(n.id));
  const rows: AsmCheckRow[] = [];
  const extras: AsmCheck["extras"] = [];
  for (const src of root.children) {
    const isExtra = extraIds.has(src.id);
    walk([src], (n) => {
      if (n.kind !== "part" || !need.has(n.id)) return;
      const p = placed.get(n.id) ?? 0;
      if (isExtra) extras.push({ node: n, srcId: src.id, qty: need.get(n.id)!, placed: p });
      else {
        const b = need.get(n.id)!;
        rows.push({ node: n, srcId: src.id, bom: b, placed: p, status: p < b ? "short" : p > b ? "over" : "ok" });
      }
    });
  }
  const shared: AsmCheck["shared"] = [];
  for (const id of g.sources) {
    const others = all.filter((o) => o.id !== g.id && o.sources.some((s) => s === id || isWithin(bomUnits, s, id) || isWithin(bomUnits, id, s)));
    if (others.length) shared.push({ id, groups: others.map((o) => o.name) });
  }
  return { rows, extras, missing, shared, ok: !missing.length && rows.every((r) => r.status === "ok") };
}
/** True when node `inner` is inside node `outer` (different nodes). */
function isWithin(units: BomNode[], outer: string, inner: string): boolean {
  if (outer === inner) return false;
  const o = findNode(units, outer)?.node;
  return !!o && !!findNode(o.children, inner);
}

// ───────────────────────── undefined mechanical parts ─────────────────────────

export interface UndefLine {
  partId: string | null;
  snap: BomNode["snap"];
  qty: number;
}
/** Quantity of a node per instance of the top node (product of the quantities below it). */
function qtyIn(top: BomNode, id: string): number {
  const hit = findNode(top.children, id);
  if (!hit) return 0;
  return hit.parents.reduce((m, p) => m * Math.max(1, Math.round(p.qty || 1)), 1) * Math.round(hit.node.qty || 0);
}
const keyOf = (n: BomNode, ctx?: BomCtx) => n.partId ?? (() => {
  const id = nodeIdentity(n, ctx);
  return `${id.manufacturer}|${id.partNumber}`.toLowerCase();
})();

/**
 * Parts defined in Mechanical Design that are not on the project BOM, per BOM unit: layout lines of rack / FNE layouts
 * that resolve to nothing in their referenced unit, and the extra parts of assembly groups (unit of their first source).
 */
export function undefinedMechParts(units: BomNode[], layouts: MechLayoutDoc[], set: AsmSet | null | undefined, ctx?: BomCtx): Map<string, UndefLine[]> {
  const acc = new Map<string, Map<string, UndefLine>>();
  const add = (unitId: string, n: BomNode, qty: number) => {
    if (qty <= 0) return;
    const m = acc.get(unitId) ?? new Map<string, UndefLine>();
    acc.set(unitId, m);
    const k = keyOf(n, ctx);
    const id = nodeIdentity(n, ctx);
    const cur = m.get(k);
    if (cur) cur.qty += qty;
    else m.set(k, { partId: n.partId ?? null, snap: n.snap ?? { manufacturer: id.manufacturer, partNumber: id.partNumber, description: id.description }, qty });
  };
  // Extras of the assembly groups are counted once, from the group (copies placed in a rack / FNE layout point at them).
  const extraIds = new Set<string>();
  for (const g of set?.groups ?? []) walk(g.extras, (n) => extraIds.add(n.id));
  for (const l of layouts) {
    const bu = refUnit(units, l.ref);
    if (!bu) continue;
    const ov = computeOverlay(l.unit, bu, ctx);
    walk(l.unit.children, (n) => {
      if (n.kind === "part" && ov.status.get(n.id) === "missing" && !(n.bomNodeId && extraIds.has(n.bomNodeId))) add(bu.id, n, qtyIn(l.unit, n.id));
    });
  }
  for (const g of set?.groups ?? []) {
    const u = g.sources.map((s) => unitOfNode(units, s)).find((x) => !!x);
    if (!u || u.mechUndef) continue;
    const top: BomNode = { id: "_", kind: "group", name: "", qty: 1, tags: [], children: g.extras };
    walk(g.extras, (n) => n.kind === "part" && add(u.id, n, qtyIn(top, n.id)));
  }
  const out = new Map<string, UndefLine[]>();
  for (const [k, m] of acc) out.set(k, [...m.values()].sort((a, b) => (a.snap?.partNumber ?? "").localeCompare(b.snap?.partNumber ?? "")));
  return out;
}

export const UNDEF_NAME = "UNDEFINED MECHANICAL PARTS";
/**
 * Keep one "UNDEFINED MECHANICAL PARTS (<unit>)" unit per BOM unit with undefined parts (after the BOM units); remove the
 * ones no longer needed. Returns the same array when nothing changes.
 */
export function syncUndefinedUnits(units: BomNode[], want: Map<string, UndefLine[]>, labelOf: (u: BomNode) => string): BomNode[] {
  const base = units.filter((u) => !u.mechUndef);
  // Generated units go after all BOM units (item letters of the BOM units are not disturbed).
  const out: BomNode[] = [...base];
  for (const u of base) {
    const lines = want.get(u.id);
    if (!lines?.length) continue;
    const old = units.find((x) => x.mechUndef === u.id);
    const children = lines.map((l) => {
      const id = `ump-${u.id}-${(l.partId ?? `${l.snap?.manufacturer}|${l.snap?.partNumber}`).replace(/[^\w|.-]/g, "_")}`;
      const prev = old?.children.find((c) => c.id === id);
      return { ...(prev ?? {}), id, kind: "part" as const, name: prev?.name ?? "", partId: l.partId ?? undefined, snap: l.snap, qty: l.qty, tags: prev?.tags ?? [], children: [] };
    });
    out.push({ ...(old ?? {}), id: old?.id ?? `ump-${u.id}`, kind: "group", name: `${UNDEF_NAME} (${labelOf(u)})`, qty: 1, tags: old?.tags ?? [], children, mechUndef: u.id });
  }
  const same = out.length === units.length && out.every((u, i) => u === units[i] || JSON.stringify(u) === JSON.stringify(units[i]));
  return same ? units : out.map((u, i) => (units[i] && JSON.stringify(u) === JSON.stringify(units[i]) ? units[i] : u));
}
