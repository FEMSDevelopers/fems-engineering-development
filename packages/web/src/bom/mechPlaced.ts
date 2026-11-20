import {
  deviceIds, findNode, latest, linkCounts, nodeIdentity, perUnitQty, placedByBom, refUnit, tagPrefixOf, tagsByBom, walk,
  type BomCtx, type BomNode, type DeviceEntry, type MechLayoutDoc, type Subcategory,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { fneLayoutStore, rackLayoutStore } from "./store";

export const PROJ_KEY = "fpl.snap.bomproject";
export const libId = (key: string): string | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}").id ?? null;
  } catch {
    return null;
  }
};

export interface MechCount {
  placed: number;
  need: number;
}
export interface ProjLayout {
  id: string | null;
  name: string;
  kind: "rack" | "fne";
  doc: MechLayoutDoc;
}

/**
 * Rack / FNE layouts that reference the open project BOM: the latest saved version of each, replaced by the open draft
 * of the same layout (the draft of an unsaved layout is included too).
 */
export function useProjectLayouts(active: boolean) {
  const [saved, setSaved] = useState<ProjLayout[]>([]);
  const [nonce, setNonce] = useState(0);
  const [rackDraft] = rackLayoutStore.use();
  const [fneDraft] = fneLayoutStore.use();
  useEffect(() => {
    if (!active) return;
    let live = true;
    (async () => {
      const out: ProjLayout[] = [];
      for (const [kind, store] of [["rack", api.mechRacks], ["fne", api.mechFnes]] as const) {
        try {
          for (const it of await store.list()) {
            const v = latest(it.versions);
            if (!v) continue;
            const r = await store.getVersion(it.id, v.major, v.minor);
            out.push({ id: it.id, name: it.name, kind, doc: r.data as MechLayoutDoc });
          }
        } catch {
          /* offline */
        }
      }
      if (live) setSaved(out);
    })();
    return () => {
      live = false;
    };
  }, [active, nonce]);
  const projectId = libId(PROJ_KEY);
  const layouts = useMemo(() => {
    const drafts: [MechLayoutDoc | null, string | null, "rack" | "fne"][] = [[rackDraft, libId("fpl.snap.mechrack"), "rack"], [fneDraft, libId("fpl.snap.mechfne"), "fne"]];
    const out: ProjLayout[] = saved.filter((s) => !drafts.some(([d, id]) => d && id === s.id));
    for (const [d, id, kind] of drafts) if (d) out.push({ id, name: saved.find((s) => s.id === id)?.name ?? (d.unit.name || (kind === "rack" ? "Rack layout (unsaved)" : "FNE layout (unsaved)")), kind, doc: d });
    return out.filter((l) => l.doc.ref && projectId && l.doc.ref.projectId === projectId);
  }, [saved, rackDraft, fneDraft, projectId]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { layouts, projectId, refresh };
}

/** Effective prefix of a BOM line (line prefix → part → subcategory, nothing when "No prefix"). */
export function prefixFinder(units: BomNode[], ctx: BomCtx | undefined, smap: Map<string, Subcategory> | undefined) {
  return (bomId: string) => {
    const n = findNode(units, bomId)?.node;
    if (!n) return "";
    const part = ctx ? nodeIdentity(n, ctx).part : undefined;
    return tagPrefixOf(n, part, part?.subcategoryId ? smap?.get(part.subcategoryId) : undefined);
  };
}

/**
 * Mechanical Design as seen from the project BOM: units placed per BOM line ("Mech" column) and the device IDs defined
 * in the layouts (device tags of the BOM lines, read only).
 */
export function useMechPlaced(units: BomNode[], active: boolean, ctx?: BomCtx, smap?: Map<string, Subcategory>) {
  const { layouts } = useProjectLayouts(active);
  return useMemo(() => {
    const placed = new Map<string, MechCount>();
    for (const u of units) {
      const ls = layouts.filter((d) => refUnit([u], d.doc.ref) === u).map((d) => d.doc);
      if (!ls.length) continue;
      const pl = placedByBom(ls, u);
      walk(u.children, (n) => {
        if (n.kind !== "part") return;
        // Parts that are not mounted (fuses, bridges, cords…) are not expected in a layout.
        if (ctx && nodeIdentity(n, ctx).part?.mech.mount === "none") return;
        placed.set(n.id, { placed: pl.get(n.id) ?? 0, need: perUnitQty(u, n.id) });
      });
    }
    const entries: DeviceEntry[] = deviceIds(layouts, prefixFinder(units, ctx, smap));
    return { placed, entries, links: linkCounts(layouts.map((l) => l.doc)), layouts, ...tagsByBom(entries) };
  }, [layouts, units, ctx, smap]);
}
