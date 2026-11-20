import {
  applyRuleSet, bumpMajor, bumpMinor, captureRuleSet, colName, fmtDateTime, headerText, matchRuleSet, ruleSummary, sameVer, stamp, verLabel,
  type ColumnMatch, type ConditionState, type RuleSetSnapshot, type Ver,
} from "@fpl/core";
import { useState } from "react";
import { api, errMsg, type RuleSet } from "../api";
import { Modal, useUi } from "../ui";

export interface TplState {
  ruleSetId: string | null;
  loaded: Ver | null;
  pending: Ver;
}

/** Rule sets: recall (with column matching) · Save rules vX · +.001 / +1. */
export function RuleSetBar(p: {
  st: ConditionState;
  ruleSets: RuleSet[];
  tpl: TplState;
  defaultName: string;
  onTpl: (t: TplState) => void;
  onApply: (st: ConditionState, t: TplState, n: number, label: string) => void;
  onChanged: () => void;
}) {
  const ui = useUi();
  const [map, setMap] = useState<{ id: string; name: string; ver: Ver; rs: RuleSetSnapshot; rows: ColumnMatch[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const cur = p.ruleSets.find((r) => r.id === p.tpl.ruleSetId);
  const vs = cur?.versions ?? [];
  const exists = !!cur && vs.some((v) => sameVer(v, p.tpl.pending));
  const label = (exists ? "Save rules v" : cur ? "Save rules as v" : "Save new rules v") + verLabel(p.tpl.pending);

  const pick = async (val: string) => {
    if (!val) {
      p.onTpl({ ruleSetId: null, loaded: null, pending: { major: 1, minor: 1 } });
      ui.toast("Next rule save creates a new rule set");
      return;
    }
    const [id, mj, mn] = val.split("|");
    try {
      const v = await api.rulesets.getVersion(id, +mj, +mn);
      const rs = v.data as RuleSetSnapshot;
      setMap({ id, name: p.ruleSets.find((r) => r.id === id)?.name ?? "", ver: { major: v.major, minor: v.minor }, rs, rows: matchRuleSet(rs, p.st) });
    } catch (e) {
      ui.toast(`Couldn’t open that rule set: ${errMsg(e)}`);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      let id = p.tpl.ruleSetId;
      if (!id || !cur) {
        const name = await ui.prompt("New rule set name", p.defaultName || `Rules ${stamp()}`, "Save rule set");
        if (!name) return;
        id = (await api.rulesets.create({ name })).id;
      }
      const snap = captureRuleSet(p.st);
      await api.rulesets.saveVersion(id, p.tpl.pending.major, p.tpl.pending.minor, { stamp: stamp(), data: snap, meta: { cols: snap.columns.length } });
      p.onTpl({ ruleSetId: id, loaded: p.tpl.pending, pending: p.tpl.pending });
      p.onChanged();
      ui.toast(`Rule set saved as v${verLabel(p.tpl.pending)} · ${snap.columns.length} columns`);
    } catch (e) {
      ui.toast(`Couldn’t save the rule set: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const selVal = cur && p.tpl.loaded ? `${cur.id}|${p.tpl.loaded.major}|${p.tpl.loaded.minor}` : "";
  return (
    <div className="savegrp">
      <select aria-label="Apply a saved rule set" value={selVal} onChange={(e) => pick(e.target.value)}>
        <option value="">{cur ? "— New rule set —" : "Rule sets…"}</option>
        {p.ruleSets.filter((r) => r.versions.length).map((r) => (
          <optgroup key={r.id} label={r.name}>
            {r.versions.map((v) => (
              <option key={`${v.major}.${v.minor}`} value={`${r.id}|${v.major}|${v.minor}`}>
                {r.name} · v{verLabel(v)} · {fmtDateTime(v.savedAt)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button type="button" className="save outline" disabled={busy} title={exists ? `Overwrites rule set v${verLabel(p.tpl.pending)}` : "Saves column names and rules as a rule set"} onClick={save}>
        {label}
      </button>
      <div className="bump">
        <button type="button" title="Next rule-set sub-version" onClick={() => p.onTpl({ ...p.tpl, pending: bumpMinor(p.tpl.pending, vs) })}>+.001</button>
        <button type="button" title="Next rule-set version" onClick={() => p.onTpl({ ...p.tpl, pending: bumpMajor(p.tpl.pending, vs) })}>+1.</button>
      </div>
      {map && (
        <MapModal
          st={p.st}
          title={`${map.name} · v${verLabel(map.ver)}`}
          rows={map.rows}
          onCancel={() => setMap(null)}
          onApply={(rows, order, settings) => {
            const next = applyRuleSet(p.st, map.rs, rows, { order, settings });
            const t = { ruleSetId: map.id, loaded: map.ver, pending: map.ver };
            p.onApply(next, t, rows.filter((r) => r.target >= 0).length, verLabel(map.ver));
            setMap(null);
          }}
        />
      )}
    </div>
  );
}

function MapModal({ st, title, rows: init, onCancel, onApply }: { st: ConditionState; title: string; rows: ColumnMatch[]; onCancel: () => void; onApply: (rows: ColumnMatch[], order: boolean, settings: boolean) => void }) {
  const [rows, setRows] = useState(init);
  const [order, setOrder] = useState(true);
  const [settings, setSettings] = useState(true);
  const w = st.grid[0]?.length ?? 0;
  const covered = new Set(rows.filter((r) => r.target >= 0).map((r) => r.target));
  const left = w - covered.size;
  return (
    <Modal onClose={onCancel} label="Apply rule set">
      <div className="mh"><h3>Apply rule set</h3><span className="mono muted">{title}</span></div>
      <div className="mb">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Each rule-set column is matched to a column in this table. Exact title matches are filled in; check the suggested and unmatched ones.</p>
        <div style={{ overflowX: "auto" }}>
          <table className="vt">
            <thead><tr><th>Rule-set column</th><th>Rules</th><th>Match</th><th>Apply to table column</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 500 }}>{r.name}</td>
                  <td className="ts">{ruleSummary(r.rules)}</td>
                  <td><span className={`tag ${r.kind}`}>{r.kind === "exact" ? "Exact" : r.kind === "suggested" ? "Suggested" : "No match"}</span></td>
                  <td>
                    <select aria-label={`Table column for ${r.name}`} value={r.target} onChange={(e) => {
                      const t = +e.target.value;
                      setRows(rows.map((x, k) => (k === i ? { ...x, target: t } : t >= 0 && x.target === t ? { ...x, target: -1 } : x)));
                    }}>
                      <option value={-1}>— Skip —</option>
                      {Array.from({ length: w }, (_, j) => <option key={j} value={j}>{colName(j)} · {headerText(st, j)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="toolbar muted" style={{ fontSize: 12.5 }}>
          <label className="ctl"><input type="checkbox" checked={order} onChange={(e) => setOrder(e.target.checked)} /> Apply key order</label>
          <label className="ctl"><input type="checkbox" checked={settings} onChange={(e) => setSettings(e.target.checked)} /> Apply column-name and literal settings</label>
        </div>
      </div>
      <div className="mf">
        <span className="info">
          {rows.filter((r) => r.target >= 0).length} of {rows.length} rule-set columns matched · {left} table column{left === 1 ? " keeps its" : "s keep their"} current rules
        </span>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => onApply(rows, order, settings)}>Apply rules</button>
      </div>
    </Modal>
  );
}
