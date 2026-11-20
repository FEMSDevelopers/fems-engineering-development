import { DEFAULT_NAME_RULE, DEFAULT_OPTIONS, type ConditionState, type Grid, type Ver } from "@fpl/core";

export interface Feed {
  sourceId: string;
  sourceName: string;
  cols: string[];
}

export interface Draft {
  st: ConditionState;
  mode: "json" | "cond";
  sample: boolean;
  /** Set when the table came from a project source; saved onto a new profile. */
  feed: Feed | null;
  lib: { profileId: string | null; loaded: Ver | null; pending: Ver; savedHash: string | null };
  tpl: { ruleSetId: string | null; loaded: Ver | null; pending: Ver };
}

export const SAMPLE: Grid = [
  ["tag", "description", "register", "data_type", "scale", "unit", "writable", "alarm.high", "alarm.low"],
  ["pcs1.p_cmd", "Active power setpoint", "40001", "int16", "0.1", "kW", "TRUE", "", ""],
  ["pcs1.q_cmd", "Reactive power setpoint", "40002", "int16", "0.1", "kvar", "TRUE", "", ""],
  ["pcs1.p_meas", "Active power measured", "30001", "int16", "0.1", "kW", "FALSE", "", ""],
  ["bms.soc", "State of charge", "30010", "uint16", "0.1", "%", "FALSE", "95", "5"],
  ["bms.soh", "State of health", "30011", "uint16", "0.1", "%", "FALSE", "", "80"],
  ["bms.cell_t_max", "Max cell temperature", "30020", "int16", "0.1", "°C", "FALSE", "45", ""],
  ["bms.v_dc", "DC bus voltage", "30030", "uint16", "0.1", "V", "FALSE", "1500", "1100"],
  ["poi.f_meas", "POI frequency", "30100", "uint32", "0.001", "Hz", "FALSE", "60.5", "59.5"],
  ["site.mode", "Operating mode", "40100", "enum", "", "", "TRUE", "", ""],
  ["site.notes", 'Free text, may contain "quotes", commas', "", "string", "", "", "FALSE", "", ""],
];

export const V1: Ver = { major: 1, minor: 1 };

export function freshState(grid: Grid, opts = DEFAULT_OPTIONS): ConditionState {
  return { grid: grid.length ? grid : [[""]], cond: [], nameRule: { ...DEFAULT_NAME_RULE }, order: [], opts: { ...opts } };
}

export const DEFAULT_DRAFT: Draft = {
  st: freshState(SAMPLE.map((r) => r.slice())),
  mode: "json",
  sample: true,
  feed: null,
  lib: { profileId: null, loaded: null, pending: V1, savedHash: null },
  tpl: { ruleSetId: null, loaded: null, pending: V1 },
};

/** Short content hash for dirty tracking. */
export function hashState(st: ConditionState): string {
  const t = JSON.stringify(st);
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ":" + t.length;
}

/** What a saved profile version stores. */
export interface ProfileData {
  grid: Grid;
  cond: ConditionState["cond"];
  nameRule: ConditionState["nameRule"];
  order: number[];
  opts: ConditionState["opts"];
}
export const toProfileData = (st: ConditionState): ProfileData => ({ grid: st.grid, cond: st.cond, nameRule: st.nameRule, order: st.order, opts: st.opts });
