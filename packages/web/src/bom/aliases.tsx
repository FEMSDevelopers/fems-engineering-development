import type { MfrAliases } from "@fpl/core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, errMsg } from "../api";
import { Modal, useUi } from "../ui";

/** Manufacturer → short-hand alias, shared by everyone (ui_presets scope "bom.mfr-alias"), used as mfr_alias / {mfra}. */
const SCOPE = "bom.mfr-alias";
let cache: MfrAliases = {};
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export async function loadAliases(force = false) {
  if (loaded && !force) return cache;
  try {
    const l = await api.presets.list<MfrAliases>(SCOPE);
    cache = l.find((p) => p.name === "aliases")?.data ?? {};
    loaded = true;
    emit();
  } catch {
    /* offline: keep what we have */
  }
  return cache;
}
export function useMfrAliases(): MfrAliases {
  useEffect(() => {
    loadAliases();
  }, []);
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => cache);
}
async function saveAliases(a: MfrAliases) {
  const clean = Object.fromEntries(Object.entries(a).filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()]));
  await api.presets.save(SCOPE, "aliases", clean);
  cache = clean;
  emit();
}

/** Parts → Manufacturer aliases…: every manufacturer of the open project BOM (and, optionally, of the master list) with its short hand. */
export function MfrAliasModal({ bomMfrs, allMfrs, onClose }: { bomMfrs: string[]; allMfrs: Map<string, number>; onClose: () => void }) {
  const ui = useUi();
  const cur = useMfrAliases();
  const [draft, setDraft] = useState<MfrAliases>(() => ({ ...cur }));
  const [all, setAll] = useState(bomMfrs.length === 0);
  const [q, setQ] = useState("");
  const inBom = useMemo(() => new Set(bomMfrs.map((m) => m.trim().toLowerCase())), [bomMfrs]);
  const get = (m: string) => draft[Object.keys(draft).find((k) => k.trim().toLowerCase() === m.trim().toLowerCase()) ?? m] ?? "";
  const put = (m: string, v: string) => {
    const k = Object.keys(draft).find((x) => x.trim().toLowerCase() === m.trim().toLowerCase()) ?? m;
    setDraft({ ...draft, [k]: v });
  };
  const names = [...new Map([...allMfrs.keys(), ...bomMfrs].map((m) => [m.trim().toLowerCase(), m.trim()])).values()]
    .filter((m) => m && (all || inBom.has(m.toLowerCase())))
    .filter((m) => !q.trim() || m.toLowerCase().includes(q.trim().toLowerCase()) || get(m).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(inBom.has(b.toLowerCase())) - Number(inBom.has(a.toLowerCase())) || a.localeCompare(b));
  return (
    <Modal onClose={onClose} label="Manufacturer aliases">
      <div className="mh"><h3>Manufacturer aliases</h3><span className="muted" style={{ fontSize: 12.5 }}>Short hand per manufacturer, used as <code>mfr_alias</code> / <code>General["ManufacturerAlias"]</code> in Python rules and <code>{"{mfra}"}</code> in document names.</span></div>
      <div className="mb">
        <div className="toolbar">
          <input type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="chk-l"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Every manufacturer of the master parts list (not only the open project BOM)</label>
        </div>
        <div className="scroll" style={{ maxHeight: "58vh" }}>
          <table className="mini wide">
            <thead><tr><th>Manufacturer</th><th>In the BOM</th><th>Parts</th><th>Alias (short hand)</th></tr></thead>
            <tbody>
              {names.map((m) => (
                <tr key={m}>
                  <td>{m}</td>
                  <td>{inBom.has(m.toLowerCase()) ? "✓" : ""}</td>
                  <td className="num">{[...allMfrs].find(([k]) => k.trim().toLowerCase() === m.toLowerCase())?.[1] ?? ""}</td>
                  <td><input type="text" className="mono" aria-label={`Alias for ${m}`} value={get(m)} placeholder={m} onChange={(e) => put(m, e.target.value)} style={{ width: 160 }} /></td>
                </tr>
              ))}
              {!names.length && <tr><td colSpan={4} className="muted">No manufacturers{all ? "" : " in the open project BOM — tick “Every manufacturer”"}.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={async () => {
          try {
            await saveAliases(draft);
            ui.toast("Manufacturer aliases saved");
            onClose();
          } catch (e) {
            ui.toast(errMsg(e));
          }
        }}>Save</button>
      </div>
    </Modal>
  );
}
