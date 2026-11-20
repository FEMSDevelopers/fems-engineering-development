import { cloneNode, groupNode, latest, partNode, walk, type AsmTemplate, type BomNode } from "@fpl/core";
import { api, type AsmItem } from "../api";
import type { Catalog } from "../bom/shared";

/** Latest version of a template, copied with fresh ids (layout re-pointed at the copies). */
export async function templateCopy(t: AsmItem): Promise<{ root: BomNode; data: AsmTemplate } | null> {
  const v = latest(t.versions);
  if (!v) return null;
  const full = await api.bomAssemblies.getVersion(t.id, v.major, v.minor);
  const data = full.data as AsmTemplate;
  const root = cloneNode(data.root);
  return { root: { ...root, name: root.name || t.name, from: { assemblyId: t.id, name: t.name, major: v.major, minor: v.minor } }, data };
}

/** Master parts picked in the New-group popup, as one batch. */
export function masterBatch(masters: { partId: string; qty: number }[], cat: Catalog, name = "ADDED PARTS"): BomNode | null {
  const kids = masters.map((m) => cat.pmap.get(m.partId)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => partNode(p, masters.find((m) => m.partId === p.id)!.qty));
  return kids.length ? groupNode(name, { children: kids }) : null;
}

/** Copy of BOM nodes for a rack / FNE layout: fresh ids, each copy linked to its BOM node (device tags, quantity check). */
export function cloneLinked(n: BomNode): BomNode {
  const ids: string[] = [];
  walk([n], (x) => ids.push(x.id));
  const c = cloneNode(n);
  const out: string[] = [];
  walk([c], (x) => out.push(x.id));
  const map = new Map(out.map((id, i) => [id, ids[i]]));
  const mark = (x: BomNode): BomNode => ({ ...x, bomNodeId: map.get(x.id), links: [map.get(x.id)!], children: x.children.map(mark) });
  return mark(c);
}
