import {
  DEFAULT_ASM_DESC, DEFAULT_PN_FORMAT, checkCriteria, latest, pnScope, renderPn, ruleFor, ruleScope, ruleTargetOf, templateToPython, verLabel,
  type AsmDescFormat, type CustomFieldDef, type Part, type PnFormat, type PnRule, type Subcategory,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Versioned } from "../api";
import { stableJson } from "../snapshots";
import { Modal, useUi } from "../ui";
import { VersionBar } from "../VersionBar";
import { useMfrAliases } from "./aliases";
import { PyEditor } from "./PyEditor";
import { useAsmDescDraft, usePnDraft } from "./store";

export const PN_KEY = "fpl.snap.pnformat";
export const DESC_KEY = "fpl.snap.asmdesc";
const EMPTY_LIB = JSON.stringify({ id: null, loaded: null, pending: { major: 1, minor: 1 }, savedHash: null });

/** Rules saved by older versions as templates become equivalent Python (every rule is Python now). */
export const pyRules = (rules: PnRule[] | undefined): PnRule[] => (rules ?? []).map((r) => (r.mode === "template" ? { ...r, mode: "python", expr: templateToPython(r.expr) } : r));
export const pyFormat = (f: Partial<PnFormat> | null | undefined): PnFormat => ({ rules: pyRules(f?.rules?.length ? f.rules : DEFAULT_PN_FORMAT.rules) });
export const pyDesc = (f: Partial<AsmDescFormat> | null | undefined): AsmDescFormat => ({ left: pyRules(f?.left ?? DEFAULT_ASM_DESC.left), right: pyRules(f?.right ?? DEFAULT_ASM_DESC.right) });

export interface ScopeSource {
  /** Master parts (manufacturer / product series choices). */
  parts: Part[];
  subcats: Subcategory[];
}
const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
const sameScope = (a: PnRule, b: Omit<PnRule, "mode" | "expr">) =>
  norm(a.subcategory === "*" ? "" : a.subcategory) === norm(b.subcategory === "*" ? "" : b.subcategory) && norm(a.manufacturer) === norm(b.manufacturer) && norm(a.series) === norm(b.series) && norm(a.when) === norm(b.when);

/**
 * A set of rules (one per manufacturer / subcategory / product series scope, or Python criteria) with the editor of one
 * rule on top: the scope is picked from the master parts list, the rule is a Python expression with the fields panel and
 * a live result for the part being edited.
 */
export function RuleSet({ rules, onChange, part, sub, src, specFields, title, emptyMeans }: {
  rules: PnRule[]; onChange: (r: PnRule[]) => void; part?: Part; sub?: string; src: ScopeSource; specFields?: CustomFieldDef[];
  title: string; emptyMeans: string;
}) {
  const aliases = useMfrAliases();
  const ctx = useMemo(() => ({ aliases }), [aliases]);
  const applied = part ? ruleFor(rules, ruleTargetOf(part, sub ?? "", ctx)) : rules.find((r) => ruleScope(r) === "* (all others)");
  const [idx, setIdx] = useState<number | null>(() => (applied ? rules.indexOf(applied) : rules.length ? 0 : null));
  const [draftScope, setDraftScope] = useState<Omit<PnRule, "mode" | "expr"> | null>(null);
  const cur: PnRule = idx != null && rules[idx] ? rules[idx] : { subcategory: "*", ...(draftScope ?? {}), mode: "python", expr: applied?.expr ?? "pn" };
  const [crit, setCrit] = useState(!!cur.when?.trim());
  useEffect(() => setCrit(!!cur.when?.trim()), [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  const mfrs = useMemo(() => [...new Set(src.parts.map((p) => p.manufacturer.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [src.parts]);
  const subNames = useMemo(() => [...new Set(src.subcats.map((s) => s.name))].sort((a, b) => a.localeCompare(b)), [src.subcats]);
  const series = useMemo(() => {
    const sid = src.subcats.find((s) => norm(s.name) === norm(cur.subcategory))?.id;
    return [...new Set(src.parts.filter((p) => (!cur.manufacturer || norm(p.manufacturer) === norm(cur.manufacturer)) && (!sid || cur.subcategory === "*" || p.subcategoryId === sid)).map((p) => p.series.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [src, cur.manufacturer, cur.subcategory]);

  const setScope = (patch: Partial<PnRule>) => {
    const sc = { subcategory: cur.subcategory, manufacturer: cur.manufacturer ?? "", series: cur.series ?? "", when: cur.when ?? "", ...patch };
    const hit = rules.findIndex((r) => sameScope(r, sc));
    if (hit >= 0) return (setIdx(hit), setDraftScope(null));
    // When the rule being edited already exists, editing its criteria text changes that rule in place.
    if (idx != null && "when" in patch && Object.keys(patch).length === 1) return onChange(rules.map((r, i) => (i === idx ? { ...r, when: patch.when } : r)));
    setIdx(null);
    setDraftScope(sc);
  };
  const setExpr = (expr: string) => {
    if (idx != null) return onChange(rules.map((r, i) => (i === idx ? { ...r, mode: "python", expr } : r)));
    onChange([...rules, { ...cur, mode: "python", expr }]);
    setIdx(rules.length);
    setDraftScope(null);
  };
  const res = part ? renderPn(cur, part, sub, ctx, "") : null;
  const crt = part && cur.when?.trim() ? checkCriteria(cur.when, pnScope(part, sub ?? "", ctx)) : null;
  const opt = (v: string, l = v) => <option key={v} value={v}>{l}</option>;
  return (
    <div className="ruleset">
      <div className="frow tight scope">
        <b className="rs-t">{title}</b>
        <label className="f">Manufacturer
          <select value={cur.manufacturer ?? ""} onChange={(e) => setScope({ manufacturer: e.target.value, series: "" })}>
            {opt("", "(any)")}
            {[...new Set([...mfrs, ...(cur.manufacturer ? [cur.manufacturer] : [])])].map((m) => opt(m))}
          </select>
        </label>
        <label className="f">Subcategory
          <select value={cur.subcategory === "*" ? "" : cur.subcategory} onChange={(e) => setScope({ subcategory: e.target.value || "*", series: "" })}>
            {opt("", "(any)")}
            {[...new Set([...subNames, ...(cur.subcategory && cur.subcategory !== "*" ? [cur.subcategory] : [])])].map((m) => opt(m))}
          </select>
        </label>
        <label className="f">Product series
          <select value={cur.series ?? ""} onChange={(e) => setScope({ series: e.target.value })}>
            {opt("", "(any)")}
            {[...new Set([...series, ...(cur.series ? [cur.series] : [])])].map((m) => opt(m))}
          </select>
        </label>
        <label className="f">Criteria
          <select value={crit ? "py" : ""} onChange={(e) => {
            const on = e.target.value === "py";
            setCrit(on);
            if (!on && cur.when) setScope({ when: "" });
          }}>
            <option value="">None</option>
            <option value="py">Python criteria…</option>
          </select>
        </label>
        <span className={`chip${idx == null ? " info" : ""}`}>{idx == null ? "new rule — created when you edit it" : `rule ${idx + 1} of ${rules.length}`}</span>
      </div>
      {crit && (
        <>
          <PyEditor label="Applies when (Python, true / false)" value={cur.when ?? ""} onChange={(v) => setScope({ when: v })} part={part} sub={sub} specFields={specFields} rows={2} placeholder={'Spec["poles"] == 3 and "3VA" in pn'}
            preview={(v) => {
              if (!part) return { text: "" };
              const c = checkCriteria(v, pnScope(part, sub ?? "", ctx));
              return { text: c.ok ? "matches this part" : "does not match this part", error: c.error };
            }} />
          {crt && <div className={`pnres${crt.error ? " err" : ""}`}><span className="muted">This part:</span><pre>{crt.error ? "error" : crt.ok ? "matches" : "does not match"}</pre>{crt.error && <span className="errtxt">{crt.error}</span>}</div>}
        </>
      )}
      <PyEditor label="Python expression (or code with return)" value={cur.expr} onChange={setExpr} part={part} sub={sub} specFields={specFields} rows={3} placeholder={'f"{pn} ({sku})" if sku else pn'}
        preview={(v) => (part ? renderPn({ ...cur, mode: "python", expr: v }, part, sub, ctx, "") : { text: "" })} />
      {res && (
        <div className={`pnres${res.error ? " err" : ""}`}>
          <span className="muted">This part:</span>
          <pre>{res.text || <span className="muted">{emptyMeans}</span>}</pre>
          {res.error && <span className="errtxt">{res.error}</span>}
          {applied && applied !== cur && <span className="muted" style={{ marginLeft: "auto" }}>but this part uses: {ruleScope(applied)}</span>}
        </div>
      )}
      <details>
        <summary className="muted">All rules ({rules.length}) — most specific wins: criteria → series → manufacturer → subcategory → *</summary>
        <table className="mini wide">
          <thead><tr><th>Applies to</th><th>Python</th>{part && <th>This part</th>}<th /></tr></thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i} className={i === idx ? "sel" : undefined} onClick={() => (setIdx(i), setDraftScope(null))} style={{ cursor: "pointer" }}>
                <td><b>{ruleScope(r)}</b>{applied === r && <span className="chip info" style={{ marginLeft: 4 }}>applies</span>}</td>
                <td className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap" }}>{r.expr}</td>
                {part && <td className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap" }}>{ruleMatchesPart(r, part, sub ?? "", ctx) ? renderPn(r, part, sub, ctx, "").text : <span className="muted">—</span>}</td>}
                <td>
                  {ruleScope(r) !== "* (all others)" && <button type="button" className="btn-ghost btn-danger" aria-label="Delete rule" onClick={(e) => {
                    e.stopPropagation();
                    onChange(rules.filter((_, j) => j !== i));
                    setIdx(null);
                  }}>✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
const ruleMatchesPart = (r: PnRule, p: Part, sub: string, ctx: { aliases: Record<string, string> }) => ruleFor([r], ruleTargetOf(p, sub, ctx)) === r;

function useLib(store: typeof api.pnFormats) {
  const [items, setItems] = useState<Versioned[]>([]);
  const refresh = useCallback(() => store.list().then(setItems).catch(() => {}), [store]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { items, refresh };
}

/** Library header: version bar (save, +.001 / +1., Saved, Recent, Edit… rename / delete, nested sub-versions) and New. */
function LibBar<D>({ storageKey, store, noun, data, defaultName, describe, restore, fresh }: {
  storageKey: string; store: typeof api.pnFormats; noun: string; data: D; defaultName: string; describe: (d: D) => Record<string, unknown>; restore: (d: D) => void; fresh: () => void;
}) {
  const ui = useUi();
  const [k, setK] = useState(0);
  return (
    <div className="toolbar">
      <VersionBar<D> key={k} storageKey={storageKey} store={store} noun={noun} data={data} canon={stableJson} defaultName={defaultName} describe={describe} restore={async (d) => restore(d)} />
      <button type="button" onClick={async () => {
        if (!(await ui.confirm(`Start a new ${noun} from the built-in rules? Unsaved changes are lost.`, "New"))) return;
        localStorage.setItem(storageKey, EMPTY_LIB);
        fresh();
        setK((x) => x + 1);
      }}>New</button>
    </div>
  );
}

/** Part editor tab "Project PN": how part numbers of a manufacturer / subcategory / series are written in bills of material. */
export function ProjectPnTab({ part, sub, src, specFields }: { part: Part; sub: string; src: ScopeSource; specFields?: CustomFieldDef[] }) {
  const [draft, setDraft] = usePnDraft();
  const fmt = useMemo(() => pyFormat(draft), [draft]);
  return (
    <div className="pntab">
      <div className="toolbar"><b>Project PN format</b>
        <LibBar<PnFormat> storageKey={PN_KEY} store={api.pnFormats} noun="part-number format" data={fmt} defaultName="Fractal BOM part numbers"
          describe={(d) => ({ rules: d.rules.length })} restore={(d) => setDraft(pyFormat(d))} fresh={() => setDraft(structuredClone(DEFAULT_PN_FORMAT))} />
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>How part numbers are written in bills of material. A rule covers a manufacturer / subcategory / product series (or Python criteria) — every part in that scope is written the same way. Projects import a saved version in Outputs.</p>
      <RuleSet title="Rule for" rules={fmt.rules} onChange={(rules) => setDraft({ rules })} part={part} sub={sub} src={src} specFields={specFields} emptyMeans="(empty → the plain part number is used)" />
    </div>
  );
}

/** Part editor tab "Assembly Descriptions": left / right text of the device in mechanical cabinet layouts. */
export function AsmDescTab({ part, sub, src, specFields }: { part: Part; sub: string; src: ScopeSource; specFields?: CustomFieldDef[] }) {
  const [draft, setDraft] = useAsmDescDraft();
  const fmt = useMemo(() => pyDesc(draft), [draft]);
  const aliases = useMfrAliases();
  const ctx = { aliases };
  const t = ruleTargetOf(part, sub, ctx);
  const left = renderPn(ruleFor(fmt.left, t), part, sub, ctx, "").text;
  const right = renderPn(ruleFor(fmt.right, t), part, sub, ctx, "").text;
  return (
    <div className="pntab">
      <div className="toolbar"><b>Assembly description format</b>
        <LibBar<AsmDescFormat> storageKey={DESC_KEY} store={api.asmDescs} noun="assembly-description format" data={fmt} defaultName="Cabinet layout descriptions"
          describe={(d) => ({ left: d.left.length, right: d.right.length })} restore={(d) => setDraft(pyDesc(d))} fresh={() => setDraft(structuredClone(DEFAULT_ASM_DESC))} />
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Text drawn on each device in Mechanical Design cabinet layouts: left-aligned and right-aligned; the middle is kept for the device tags of the project BOM version referenced by the layout. Layouts import a saved version (BOM reference bar → Descriptions…).</p>
      <div className="descprev" aria-label="Preview">
        <pre className="l">{left}</pre>
        <span className="m"><span className="bubble">-TAG.01</span></span>
        <pre className="r">{right}</pre>
      </div>
      <RuleSet title="Left" rules={fmt.left} onChange={(l) => setDraft({ ...fmt, left: l })} part={part} sub={sub} src={src} specFields={specFields} emptyMeans="(empty)" />
      <RuleSet title="Right" rules={fmt.right} onChange={(r) => setDraft({ ...fmt, right: r })} part={part} sub={sub} src={src} specFields={specFields} emptyMeans="(empty)" />
    </div>
  );
}

type From = { id: string; name: string; major: number; minor: number } | null;
/** Import a saved version of a library (part-number formats or assembly descriptions). */
function ImportLib<D>({ store, noun, where, onClose, onPick, fallback, fix }: {
  store: typeof api.pnFormats; noun: string; where: string; onClose: () => void; onPick: (from: From, d: D) => void; fallback: () => D; fix: (d: unknown) => D;
}) {
  const { items } = useLib(store);
  const [v, setV] = useState("");
  const l0 = items[0] && latest(items[0].versions);
  const val = v || (l0 ? `${items[0].id}|${l0.major}|${l0.minor}` : "");
  return (
    <Modal size="sm" onClose={onClose} label={`Import ${noun}`}>
      <div className="mh"><h3>Import a {noun}</h3></div>
      <div className="mb">
        <label className="f">Format and version
          <select value={val} onChange={(e) => setV(e.target.value)}>
            <option value="">Built-in rules</option>
            {items.map((x) => <optgroup key={x.id} label={x.name}>{x.versions.map((ver) => <option key={`${ver.major}.${ver.minor}`} value={`${x.id}|${ver.major}|${ver.minor}`}>{x.name} v{verLabel(ver)}</option>)}</optgroup>)}
          </select>
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{where}</p>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={async () => {
          if (!val) return onPick(null, fallback());
          const [id, a, b] = val.split("|");
          const ver = await store.getVersion(id, +a, +b);
          onPick({ id, name: items.find((x) => x.id === id)?.name ?? "", major: +a, minor: +b }, fix(ver.data));
        }}>Import</button>
      </div>
    </Modal>
  );
}
export const ImportPnFormat = ({ onClose, onPick }: { onClose: () => void; onPick: (from: From, f: PnFormat) => void }) => (
  <ImportLib<PnFormat> store={api.pnFormats} noun="part-number format" where="Formats are edited in Parts → Edit part → Configuration & standards → Project PN." onClose={onClose} onPick={onPick} fallback={() => structuredClone(DEFAULT_PN_FORMAT)} fix={(d) => pyFormat(d as PnFormat)} />
);
export const ImportAsmDesc = ({ onClose, onPick }: { onClose: () => void; onPick: (from: From, f: AsmDescFormat) => void }) => (
  <ImportLib<AsmDescFormat> store={api.asmDescs} noun="assembly-description format" where="Formats are edited in Parts → Edit part → Configuration & standards → Assembly Descriptions." onClose={onClose} onPick={onPick} fallback={() => structuredClone(DEFAULT_ASM_DESC)} fix={(d) => pyDesc(d as AsmDescFormat)} />
);

/** Project / layout copy editors (no part preview). */
export function PnRulesModal({ title, fmt, onChange, onClose, src }: { title: string; fmt: PnFormat; onChange: (f: PnFormat) => void; onClose: () => void; src: ScopeSource }) {
  return (
    <Modal onClose={onClose} label={title}>
      <div className="mh"><h3>{title}</h3><span className="muted" style={{ fontSize: 12.5 }}>Saved with this version; the shared format is not changed.</span></div>
      <div className="mb"><RuleSet title="Rule for" rules={pyFormat(fmt).rules} onChange={(rules) => onChange({ rules })} src={src} emptyMeans="" /></div>
      <div className="mf"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
export function AsmDescModal({ title, fmt, onChange, onClose, src, onImport }: { title: string; fmt: AsmDescFormat | null; onChange: (f: AsmDescFormat | null) => void; onClose: () => void; src: ScopeSource; onImport: () => void }) {
  const f = pyDesc(fmt);
  return (
    <Modal onClose={onClose} label={title}>
      <div className="mh"><h3>{title}</h3><span className="muted" style={{ fontSize: 12.5 }}>Saved with this layout version; the shared format is not changed.</span></div>
      <div className="mb">
        <div className="toolbar">
          <button type="button" onClick={onImport}>Import a saved format…</button>
          {fmt && <button type="button" className="btn-ghost" onClick={() => onChange(null)}>Use the built-in format</button>}
        </div>
        <RuleSet title="Left" rules={f.left} onChange={(l) => onChange({ ...f, left: l })} src={src} emptyMeans="" />
        <RuleSet title="Right" rules={f.right} onChange={(r) => onChange({ ...f, right: r })} src={src} emptyMeans="" />
      </div>
      <div className="mf"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
