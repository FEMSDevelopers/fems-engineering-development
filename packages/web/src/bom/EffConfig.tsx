import { effCfgOf, effVerLabel, effectiveDesc, effectivePn, effectivePrice, nextEffVersion, newId, type CustomFieldDef, type EffVersion, type MfrAliases, type Part } from "@fpl/core";
import { useEffect, useRef, useState } from "react";
import { HoldButton, Modal, useLocal, useUi } from "../ui";
import { PyEditor } from "./PyEditor";
import { NumIn, fmtN } from "./shared";

type Draft = Omit<Part, "id"> & { id?: string };
type Patch = Partial<Pick<Part, "effPnExpr" | "effDescExpr" | "effPrice" | "effApply" | "effVersions" | "effVersionId" | "sku" | "configCode1" | "configCode2" | "configCode3">>;

/** Common effective part number / description definitions (Quick start). */
const PN_PRESETS: [string, string][] = [
  ["Same as the part number", ""],
  ["Part number + configuration codes (pn-config1-config2-config3)", '"-".join(c for c in [pn, config1, config2, config3] if c)'],
  ["Part number followed by configuration code #1", "pn + config1"],
  ["SKU, else the part number", "sku or pn"],
  ["Part number (SKU)", 'f"{pn} ({sku})" if sku else pn'],
];
const DESC_PRESETS: [string, string][] = [
  ["Same as the description", ""],
  ["Description, configuration codes", '", ".join(c for c in [desc, config1, config2, config3] if c)'],
  ["Description (configuration code #1)", 'f"{desc} ({config1})" if config1 else desc'],
  ["Description, SKU", 'f"{desc}, SKU {sku}" if sku else desc'],
];

/**
 * Edit part → Configuration: effective part number, effective description and price of the custom configuration, with
 * saved versions (save / +.001 / +1. / add / edit notes / delete; dropdown with the version, effective PN, effective
 * description, price, SKU and configuration codes of each, recent first or by number) and the "Apply custom PN / DESC" switch. Version actions are
 * stored with the part at once (`persist`); the fields are saved with the part.
 */
export function EffConfig({ d, sub, specFields, aliases, onChange, persist }: {
  d: Draft; sub: string; specFields?: CustomFieldDef[]; aliases: MfrAliases;
  onChange: (p: Patch) => void; persist: (p: Patch) => Promise<void>;
}) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [recent, setRecent] = useLocal<boolean>("fpl.bom.effRecent", true);
  const box = useRef<HTMLDivElement>(null);
  const versions = d.effVersions ?? [];
  const cur = versions.find((v) => v.id === d.effVersionId) ?? null;
  const apply = !!d.effApply;
  // The working values a version stores: effective PN / DESC expressions, price, SKU and configuration codes #1–#3.
  const draft = { pnExpr: d.effPnExpr ?? "", descExpr: d.effDescExpr ?? "", price: d.effPrice ?? null, sku: d.sku ?? "", configCode1: d.configCode1 ?? "", configCode2: d.configCode2 ?? "", configCode3: d.configCode3 ?? "" };
  type Draft2 = typeof draft;
  const CODES = ["sku", "configCode1", "configCode2", "configCode3"] as const;
  const dirty = cur
    ? cur.pnExpr !== draft.pnExpr || cur.descExpr !== draft.descExpr || (cur.price ?? null) !== draft.price || CODES.some((k) => (cur[k] ?? "") !== draft[k])
    : !!(draft.pnExpr || draft.descExpr || draft.price != null);
  /** Fields of the part set from a version (loaded) or kept with it (saved). */
  const fieldsOf = (v: Draft2): Patch => ({ effPnExpr: v.pnExpr, effDescExpr: v.descExpr, effPrice: v.price, sku: v.sku, configCode1: v.configCode1, configCode2: v.configCode2, configCode3: v.configCode3 });
  const ctx = { aliases };
  // Results always shown as applied (the switch decides whether they are used).
  const on = { ...d, effApply: true };
  const pnRes = effectivePn(on, sub, ctx);
  const descRes = effectiveDesc(on, sub, ctx);
  const effPn = effectivePn(d, sub, ctx).text;
  const effDesc = effectiveDesc(d, sub, ctx).text;
  const price = effectivePrice(d);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [open]);

  const store = async (list: EffVersion[], id: string | null, extra: Patch = {}) => {
    const p: Patch = { effVersions: list, effVersionId: id, ...extra };
    onChange(p);
    await persist(p).catch((e) => ui.toast(String((e as Error).message ?? e)));
  };
  // Configurations: distinct named variants of the part (same documentation), each with its own versions.
  const curCfg = cur ? effCfgOf(cur) : null;
  const cfgs = [...new Map(versions.map((v) => [effCfgOf(v).id, effCfgOf(v)])).values()];
  const inCfg = (id: string) => versions.filter((v) => effCfgOf(v).id === id);
  const make = (n: { major: number; minor: number }, cfg: { id: string; name: string }, from: Draft2 = draft): EffVersion =>
    ({ id: newId(), cfgId: cfg.id, cfgName: cfg.name, ...n, ...from, notes: "", savedAt: new Date().toISOString() });
  const label = (v: EffVersion) => `${effCfgOf(v).name} ${effVerLabel(v)}`;
  /** New configuration: a name, empty SKU / codes and price, the current expressions; saved as its v1.001 and loaded. */
  const newCfg = async (blank = true) => {
    if (dirty && cur && !(await ui.confirm(`Start a new configuration? The unsaved changes of ${label(cur)} are lost (Save first to keep them).`, "New"))) return;
    let n = cfgs.length + 1;
    while (cfgs.some((c) => c.name.toLowerCase() === `configuration ${n}`)) n++;
    const name = (await ui.prompt("Name of the new configuration (e.g. 1P+N C16 30mA, with auxiliary contact…)", `Configuration ${n}`, "Create"))?.trim();
    if (!name) return;
    if (cfgs.some((c) => c.name.toLowerCase() === name.toLowerCase())) return ui.toast(`A configuration “${name}” already exists`);
    const from: Draft2 = blank ? { ...draft, sku: "", configCode1: "", configCode2: "", configCode3: "", price: null } : draft;
    const v = make({ major: 1, minor: 1 }, { id: newId(), name }, from);
    await store([...versions, v], v.id, fieldsOf(from));
    ui.toast(`Configuration “${name}” created (v1.001) — enter its SKU / configuration codes and Save`);
  };
  const save = async () => {
    if (!cur) return newCfg(false);
    await store(versions.map((v) => (v.id === cur.id ? { ...v, ...draft, savedAt: new Date().toISOString() } : v)), cur.id, fieldsOf(draft));
    ui.toast(`${label(cur)} saved`);
  };
  const saveNew = async (kind: "minor" | "major") => {
    if (!cur || !curCfg) return newCfg(false);
    const v = make(nextEffVersion(inCfg(curCfg.id), kind, cur), curCfg);
    await store([...versions, v], v.id, fieldsOf(draft));
    ui.toast(`Saved as ${label(v)}`);
  };
  const add = async () => {
    if (!cur || !curCfg) return newCfg();
    // Empty effective PN / DESC / price in this configuration; keeps its SKU and configuration codes.
    const empty = { ...draft, pnExpr: "", descExpr: "", price: null };
    const v = make(nextEffVersion(inCfg(curCfg.id), "minor", cur), curCfg, empty);
    await store([...versions, v], v.id, fieldsOf(empty));
    ui.toast(`${label(v)} added (part number and description)`);
  };
  const load = async (v: EffVersion) => {
    if (dirty && !(await ui.confirm(`Load ${label(v)}? The unsaved changes of the effective PN / description / price are lost.`, "Load"))) return;
    setOpen(false);
    // Versions saved before SKU / codes were kept leave the part's current ones unchanged.
    await store(versions, v.id, fieldsOf({ pnExpr: v.pnExpr, descExpr: v.descExpr, price: v.price, sku: v.sku ?? draft.sku, configCode1: v.configCode1 ?? draft.configCode1, configCode2: v.configCode2 ?? draft.configCode2, configCode3: v.configCode3 ?? draft.configCode3 }));
  };
  const order = (l: EffVersion[]) => [...l].sort((a, b) => (recent ? b.savedAt.localeCompare(a.savedAt) : a.major - b.major || a.minor - b.minor));
  const last = (id: string) => inCfg(id).reduce((m, v) => (v.savedAt > m ? v.savedAt : m), "");
  const groups = [...cfgs].sort((a, b) => (recent ? last(b.id).localeCompare(last(a.id)) : a.name.localeCompare(b.name))).map((c) => ({ c, list: order(inCfg(c.id)) }));
  const res = (v: EffVersion) => {
    const vp = { ...d, effApply: true, sku: v.sku ?? d.sku, configCode1: v.configCode1 ?? d.configCode1, configCode2: v.configCode2 ?? d.configCode2, configCode3: v.configCode3 ?? d.configCode3 };
    return {
    pn: effectivePn({ ...vp, effPnExpr: v.pnExpr }, sub, ctx).text,
    desc: effectiveDesc({ ...vp, effDescExpr: v.descExpr }, sub, ctx).text,
    codes: [vp.sku && `SKU ${vp.sku}`, vp.configCode1, vp.configCode2, vp.configCode3].filter(Boolean).join(" · "),
    price: v.price ?? d.price ?? null,
    };
  };

  return (
    <div className={`effcfg${apply ? "" : " off"}`}>
      <div className="effbar">
        <label className="switch" title="On: the effective part number / description / price below are used (BOM, outputs, Python epn / edesc). Off: the part number, description and unit price are used; every field stays editable and versions can still be saved and loaded.">
          <input type="checkbox" role="switch" aria-label="Apply custom PN/DESC" checked={apply} onChange={async (e) => {
            onChange({ effApply: e.target.checked });
            await persist({ effApply: e.target.checked }).catch(() => undefined);
          }} /> Apply custom PN/DESC
        </label>
        <div className="effver" ref={box}>
          <button type="button" className="effverbtn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            title={cur ? `${label(cur)} · ${res(cur).pn}\n${res(cur).desc}${res(cur).codes ? `\n${res(cur).codes}` : ""}` : "Saved configurations (versions)"}>
            {cur ? <><b className="effcfgname">{curCfg?.name}</b><b className="mono">{effVerLabel(cur)}</b><span className="mono effverpn">{res(cur).pn}</span></> : <span className="muted">No saved configuration</span>}
            {dirty ? <span className="chip warn" title="Unsaved changes">●</span> : null} <span aria-hidden="true">▾</span>
          </button>
          {open && (
            <div className="effdrop" role="listbox" aria-label="Custom PN/DESC versions">
              <div className="effdrop-h">
                <b>Configurations ({cfgs.length})</b>
                <span className="muted" style={{ fontSize: 11.5 }}>{versions.length} version{versions.length === 1 ? "" : "s"} · each with its own SKU / codes, effective PN and description · same documentation</span>
                <span className="grow" />
                <span className="seg mini" role="group" aria-label="Order">
                  <button type="button" aria-pressed={recent} onClick={() => setRecent(true)}>Recent</button>
                  <button type="button" aria-pressed={!recent} onClick={() => setRecent(false)}>Version</button>
                </span>
              </div>
              {versions.length ? (
                <table className="mini effvtab">
                  <thead><tr><th>Version</th><th>Effective PN</th><th>Effective description</th><th className="num">Price</th><th title="SKU and configuration codes #1–#3 of the version">SKU / codes</th></tr></thead>
                  {groups.map(({ c, list }) => (
                  <tbody key={c.id}>
                    <tr className="effgrp"><td colSpan={5}><b>{c.name}</b> <span className="muted">· {list.length} version{list.length === 1 ? "" : "s"}</span></td></tr>
                    {list.map((v) => {
                      const r = res(v);
                      return (
                        <tr key={v.id} role="option" aria-selected={v.id === cur?.id} className={v.id === cur?.id ? "sel" : undefined} onClick={() => void load(v)} title={`${v.notes ? `${v.notes}\n` : ""}Saved ${new Date(v.savedAt).toLocaleString()}\nPN: ${v.pnExpr || "pn"}\nDESC: ${v.descExpr || "desc"}${v.sku ? `\nSKU: ${v.sku}` : ""}${[v.configCode1, v.configCode2, v.configCode3].some(Boolean) ? `\nCodes: ${[v.configCode1, v.configCode2, v.configCode3].join(" | ")}` : ""}`}>
                          <td className="mono">{v.id === cur?.id ? "✓ " : ""}{effVerLabel(v)}{v.notes ? <span className="muted"> · {v.notes.slice(0, 24)}</span> : null}</td>
                          <td className="mono">{r.pn}</td>
                          <td className="clipc">{r.desc}</td>
                          <td className="num">{r.price == null ? "" : fmtN(r.price, 2)}</td>
                          <td className="mono clipc" title={r.codes}>{r.codes}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  ))}
                </table>
              ) : <p className="muted" style={{ margin: 8, fontSize: 12.5 }}>No configuration yet: New… (or Save) creates one with the SKU / codes, effective PN / description and price as its v1.001.</p>}
            </div>
          )}
        </div>
        <button type="button" className="btn-primary" onClick={() => void newCfg()} title="New configuration of this part (its own SKU / configuration codes, effective PN / description, price and versions; same documentation)">New…</button>
        <button type="button" onClick={() => void save()} title={cur ? `Save over ${label(cur)}` : "Save as a new configuration (v1.001)"}>Save</button>
        <button type="button" className="btn-ghost" onClick={() => void saveNew("minor")} title="Save as the next sub-version">+.001</button>
        <button type="button" className="btn-ghost" onClick={() => void saveNew("major")} title="Save as the next version">+1.</button>
        <button type="button" className="btn-ghost" onClick={() => void add()} title="New empty version of this configuration (part number and description)">+ Add</button>
        <button type="button" className="btn-ghost" disabled={!cur} onClick={() => setEdit(true)}>Edit…</button>
        {cur && <HoldButton ms={500} className="btn-ghost btn-danger" label={`Delete ${label(cur)}`} onHold={() => void store(versions.filter((v) => v.id !== cur.id), null).then(() => ui.toast(`${label(cur)} deleted`))}>Delete</HoldButton>}
        <span className="effnow" title="Effective values used now">
          <span className="muted">{apply ? "Used:" : "Not applied — used:"}</span> <b className="mono">{effPn}</b> · <span>{effDesc || <span className="muted">(no description)</span>}</span>{price != null ? <> · <b>{fmtN(price, 2)}</b></> : null}
        </span>
      </div>
      {/* The content of this configuration: SKU and configuration codes (used by the effective PN / DESC below). */}
      <div className="effrow effcodes">
        {([["sku", "SKU", 160], ["configCode1", "Configuration code #1", 190], ["configCode2", "Configuration code #2", 190], ["configCode3", "Configuration code #3", 190]] as const).map(([k, l, w]) => (
          <label key={k} className="f">{l}<input type="text" className="mono" aria-label={l} value={d[k] ?? ""} onChange={(e) => onChange({ [k]: e.target.value })} style={{ width: w }} /></label>
        ))}
        <span className="muted" style={{ fontSize: 12, paddingBottom: 6 }}>Saved with each configuration; <code>sku</code>, <code>config1</code>–<code>config3</code> in the expressions below.</span>
      </div>
      <div className="effrow">
        <PyEditor compact label="Effective part number (Python; empty = the part number)" value={draft.pnExpr} onChange={(v) => onChange({ effPnExpr: v })}
          part={d} sub={sub} specFields={specFields} placeholder="pn  (the part number)"
          help="Part number as ordered / referenced: the part number for most parts; for configured items or parts with a SKU, combine the fields — e.g. f&quot;{pn}-{config1}&quot;, sku or pn. Expression, or code ending with return."
          preview={() => pnRes} />
        <Presets label="Effective part number presets" list={PN_PRESETS} onPick={(x) => onChange({ effPnExpr: x })} />
        <span className="effres"><span className="muted">Effective PN</span> <b className="mono">{pnRes.text || "—"}</b>{pnRes.error && <span className="errtxt"> · {pnRes.error}</span>}</span>
      </div>
      <div className="effrow">
        <PyEditor compact label="Effective DESC (Python; empty = the description)" value={draft.descExpr} onChange={(v) => onChange({ effDescExpr: v })}
          part={d} sub={sub} specFields={specFields} placeholder="desc  (the description)"
          help="Description as ordered / listed: the description (Item information → General) for most parts; a custom description when the item requires it — e.g. f&quot;{desc}, {config1}&quot;, or a text in quotes. Expression, or code ending with return."
          preview={() => descRes} />
        <Presets label="Effective description presets" list={DESC_PRESETS} onPick={(x) => onChange({ effDescExpr: x })} />
        <span className="effres"><span className="muted">Effective DESC</span> <span>{descRes.text || "—"}</span>{descRes.error && <span className="errtxt"> · {descRes.error}</span>}</span>
      </div>
      <div className="effrow">
        <label className="f">Price of the configuration<NumIn label="Price of the configuration" value={draft.price} onChange={(v) => onChange({ effPrice: v })} width={110} placeholder={d.price != null ? fmtN(d.price, 2) : "unit price"} /></label>
        <span className="muted" style={{ fontSize: 12 }}>Empty = the unit price{d.price != null ? ` (${fmtN(d.price, 2)})` : ""}.</span>
      </div>
      {edit && cur && curCfg && <EditVersion v={cur} cfgName={curCfg.name} versions={inCfg(curCfg.id).length} names={cfgs.filter((c) => c.id !== curCfg.id).map((c) => c.name)} onClose={() => setEdit(false)}
        onSave={async (notes, name) => {
          setEdit(false);
          // Renaming the configuration renames it on all of its versions.
          await store(versions.map((v) => (v.id === cur.id ? { ...v, notes } : v)).map((v) => (effCfgOf(v).id === curCfg.id ? { ...v, cfgId: curCfg.id, cfgName: name } : v)), cur.id);
        }}
        onDeleteCfg={async () => {
          setEdit(false);
          await store(versions.filter((v) => effCfgOf(v).id !== curCfg.id), null);
          ui.toast(`Configuration “${curCfg.name}” deleted`);
        }} />}
    </div>
  );
}

function Presets({ label, list, onPick }: { label: string; list: [string, string][]; onPick: (x: string) => void }) {
  return (
    <label className="f">Quick start
      <select aria-label={label} value="__" onChange={(e) => e.target.value !== "__" && onPick(e.target.value === "__empty" ? "" : e.target.value)}>
        <option value="__">Presets…</option>
        {list.map(([l, x]) => <option key={l} value={x || "__empty"}>{l}</option>)}
      </select>
    </label>
  );
}

function EditVersion({ v, cfgName, versions, names, onSave, onDeleteCfg, onClose }: {
  v: EffVersion; cfgName: string; versions: number; names: string[]; onSave: (notes: string, name: string) => void; onDeleteCfg: () => void; onClose: () => void;
}) {
  const [notes, setNotes] = useState(v.notes);
  const [name, setName] = useState(cfgName);
  const clash = names.some((n) => n.toLowerCase() === name.trim().toLowerCase());
  return (
    <Modal onClose={onClose} label={`Edit ${cfgName} ${effVerLabel(v)}`}>
      <div className="mh"><h3>Edit {cfgName} {effVerLabel(v)}</h3><span className="muted" style={{ fontSize: 12.5 }}>Saved {new Date(v.savedAt).toLocaleString()}</span></div>
      <div className="mb">
        <label className="f">Configuration name ({versions} version{versions === 1 ? "" : "s"})<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        {clash && <p className="errtxt" style={{ margin: 0 }}>Another configuration is already named “{name.trim()}”.</p>}
        <label className="f">Notes of {effVerLabel(v)} (shown in the list)<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus /></label>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Effective PN: <code>{v.pnExpr || "pn"}</code> · Effective DESC: <code>{v.descExpr || "desc"}</code> · Price: {v.price == null ? "unit price" : fmtN(v.price, 2)} · SKU: {v.sku || "—"} · Codes: {[v.configCode1, v.configCode2, v.configCode3].map((c) => c || "—").join(" | ")}. To change them, load the version, edit the fields and Save.</p>
      </div>
      <div className="mf">
        <HoldButton ms={500} className="btn-ghost btn-danger" label={`Delete configuration ${cfgName}`} onHold={onDeleteCfg}>Delete configuration (all {versions})</HoldButton>
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!name.trim() || clash} onClick={() => onSave(notes.trim(), name.trim())}>Save</button>
      </div>
    </Modal>
  );
}
