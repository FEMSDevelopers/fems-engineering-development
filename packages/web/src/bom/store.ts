import { storageWritable } from "../project";
import { DEFAULT_SORT, type SortFormat, DEFAULT_ASM_DESC, DEFAULT_NAMING, DEFAULT_PN_FORMAT, type AsmDescFormat, type PnFormat, emptyBomDoc, groupNode, type AsmTemplate, type BomDoc, type MechLayoutDoc, type NamingStandard } from "@fpl/core";
import { useCallback, useSyncExternalStore } from "react";

/**
 * A value shared by every module (Parts & BOM and Mechanical Design edit the same open project BOM and template draft),
 * kept in localStorage so drafts survive a reload.
 */
function createStore<T>(key: string, init: () => T, merge?: (stored: T) => T) {
  let value: T = (() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (merge ? merge(JSON.parse(s)) : JSON.parse(s)) : init();
    } catch {
      return init();
    }
  })();
  const subs = new Set<() => void>();
  let timer = 0;
  const persist = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      try {
        // Another tab switched project: this page's content must not land in the new project's keys.
        if (storageWritable(key)) localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage full or blocked: keep working in memory */
      }
    }, 150);
  };
  const set = (v: T | ((p: T) => T)) => {
    value = typeof v === "function" ? (v as (p: T) => T)(value) : v;
    persist();
    subs.forEach((f) => f());
  };
  const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));
  return {
    get: () => value,
    set,
    use(): [T, (v: T | ((p: T) => T)) => void] {
      const v = useSyncExternalStore(subscribe, () => value);
      return [v, useCallback(set, [])];
    },
  };
}

export const bomDocStore = createStore<BomDoc>("fpl.bom.doc", emptyBomDoc, (d) => ({ ...emptyBomDoc(), ...d }));
export const asmDraftStore = createStore<AsmTemplate>("fpl.bom.asmdraft", () => ({ kind: "RU", root: groupNode("NEW ASSEMBLY"), notes: "" }));
export const useBomDoc = () => bomDocStore.use();
export const useAsmDraft = () => asmDraftStore.use();
export const namingDraftStore = createStore<NamingStandard>("fpl.bom.namingdraft", () => structuredClone(DEFAULT_NAMING));
export const useNamingDraft = () => namingDraftStore.use();
/** Open rack and FNE layouts of Mechanical Design (each saved with its own version bar). */
export const rackLayoutStore = createStore<MechLayoutDoc | null>("fpl.mech.rackdoc", () => null);
export const fneLayoutStore = createStore<MechLayoutDoc | null>("fpl.mech.fnedoc", () => null);
export const pnFormatDraftStore = createStore<PnFormat>("fpl.bom.pndraft", () => structuredClone(DEFAULT_PN_FORMAT));
export const usePnDraft = () => pnFormatDraftStore.use();
export const asmDescDraftStore = createStore<AsmDescFormat>("fpl.bom.descdraft", () => structuredClone(DEFAULT_ASM_DESC));
export const useAsmDescDraft = () => asmDescDraftStore.use();
export const sortDraftStore = createStore<SortFormat>("fpl.bom.sortdraft", () => ({ ...DEFAULT_SORT }));
export const useSortDraft = () => sortDraftStore.use();

/**
 * Units of Edit part (shared by every project; values are always stored in kg and °C): IMP | M sets both, the weight
 * (g | lb) and temperature (°C | °F) toggles override one each.
 */
export interface PartUnits { sys: "M" | "IMP"; weight: "g" | "lb"; temp: "C" | "F"; /** Dimensions & 2D views inputs (stored in mm). */ dim: "mm" | "in" }
const oldF = (() => {
  try {
    return localStorage.getItem("fpl.bom.tempF") === "true";
  } catch {
    return false;
  }
})();
export const unitsStore = createStore<PartUnits>("fpl.bom.units", () => ({ sys: oldF ? "IMP" : "M", weight: oldF ? "lb" : "g", temp: oldF ? "F" : "C", dim: "mm" }), (u) => ({ ...({ sys: "M", weight: "g", temp: "C", dim: "mm" } as PartUnits), ...u }));
export const useUnits = () => unitsStore.use();
