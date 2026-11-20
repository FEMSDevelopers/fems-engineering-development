import { useEffect, useState } from "react";
import { api, errMsg, type Preset } from "../api";
import { Modal, useUi } from "../ui";

export interface ColLayout {
  order: string[];
  hidden: string[];
}

/** Layout with unknown keys dropped and new columns appended (new columns hidden if listed in `defaultHidden`). */
export function normalizeLayout(l: Partial<ColLayout> | undefined, keys: string[], defaultHidden: string[] = []): ColLayout {
  const known = new Set(keys);
  const order = (l?.order ?? []).filter((k) => known.has(k));
  const seen = new Set(order);
  const added = keys.filter((k) => !seen.has(k));
  const hidden = (l?.hidden ?? defaultHidden).filter((k) => known.has(k));
  if (l?.order) for (const k of added) if (defaultHidden.includes(k) && !hidden.includes(k)) hidden.push(k);
  return { order: [...order, ...added], hidden };
}

export const PRESET_SCOPE = "dataflow.columns";

/** Shared, server-side named column layouts. */
export function useColumnPresets() {
  const [presets, setPresets] = useState<Preset<ColLayout>[]>([]);
  const reload = async () => {
    try {
      setPresets(await api.presets.list<ColLayout>(PRESET_SCOPE));
    } catch {
      /* presets are optional */
    }
  };
  useEffect(() => {
    reload();
  }, []);
  return { presets, reload };
}

export function ColumnsModal({
  cols, layout, defaults, current, onApply, onClose, presets, reloadPresets,
}: {
  cols: { key: string; label: string }[];
  layout: ColLayout;
  defaults: ColLayout;
  /** Name of the preset last loaded, if any. */
  current: string;
  onApply: (l: ColLayout, presetName: string) => void;
  onClose: () => void;
  presets: Preset<ColLayout>[];
  reloadPresets: () => Promise<void>;
}) {
  const ui = useUi();
  const [l, setL] = useState<ColLayout>(layout);
  const [name, setName] = useState(current);
  const [drag, setDrag] = useState<string | null>(null);
  const label = new Map(cols.map((c) => [c.key, c.label]));
  const keys = cols.map((c) => c.key);

  const move = (k: string, to: number) => {
    const o = l.order.filter((x) => x !== k);
    o.splice(Math.max(0, Math.min(o.length, to)), 0, k);
    setL({ ...l, order: o });
  };
  const toggle = (k: string) => setL({ ...l, hidden: l.hidden.includes(k) ? l.hidden.filter((x) => x !== k) : [...l.hidden, k] });
  const shown = l.order.filter((k) => !l.hidden.includes(k)).length;

  const saveAs = async () => {
    const n = await ui.prompt("Preset name (e.g. Leandro – commissioning). An existing name is overwritten.", name || "");
    if (!n) return;
    try {
      await api.presets.save(PRESET_SCOPE, n, l);
      await reloadPresets();
      setName(n);
      ui.toast(`Saved preset “${n}”`);
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    }
  };
  const del = async (p: Preset<ColLayout>) => {
    if (!(await ui.confirm(`Delete preset “${p.name}”? Everyone using this project loses it.`, "Delete"))) return;
    await api.presets.remove(p.id);
    if (name === p.name) setName("");
    await reloadPresets();
  };

  return (
    <Modal onClose={onClose} label="Manage columns">
      <div className="mh"><h3>Manage columns</h3></div>
      <div className="mb colmgr">
        <div>
          <p className="muted" style={{ margin: "0 0 6px", fontSize: 12.5 }}>Tick to show; drag ⋮⋮ or use ↑ ↓ to reorder. {shown} of {keys.length} shown.</p>
          <ul className="collist" aria-label="Columns">
            {l.order.map((k, i) => (
              <li
                key={k}
                draggable
                className={drag === k ? "dragging" : undefined}
                onDragStart={() => setDrag(k)}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (drag && drag !== k) move(drag, i);
                }}
              >
                <span className="grip" aria-hidden="true">⋮⋮</span>
                <label>
                  <input type="checkbox" checked={!l.hidden.includes(k)} onChange={() => toggle(k)} /> {label.get(k)}
                </label>
                <span className="grow" />
                <button type="button" className="btn-ghost" aria-label={`Move ${label.get(k)} up`} disabled={i === 0} onClick={() => move(k, i - 1)}>↑</button>
                <button type="button" className="btn-ghost" aria-label={`Move ${label.get(k)} down`} disabled={i === l.order.length - 1} onClick={() => move(k, i + 1)}>↓</button>
              </li>
            ))}
          </ul>
          <div className="toolbar" style={{ marginTop: 6 }}>
            <button type="button" onClick={() => setL({ ...l, hidden: [] })}>Show all</button>
            <button type="button" onClick={() => setL(defaults)}>Reset to default</button>
          </div>
        </div>
        <div className="presets">
          <h4>Saved layouts</h4>
          <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>Stored in the project database so each person can keep and reload their own workflow.</p>
          {!presets.length && <p className="muted" style={{ fontSize: 12.5 }}>None yet.</p>}
          <ul className="plist">
            {presets.map((p) => (
              <li key={p.id} className={p.name === name ? "cur" : undefined}>
                <button type="button" className="btn-ghost pname" title="Load this layout" onClick={() => { setL(normalizeLayout(p.data, keys)); setName(p.name); }}>{p.name}</button>
                <button type="button" className="btn-ghost btn-danger" aria-label={`Delete preset ${p.name}`} onClick={() => del(p)}>✕</button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={saveAs}>Save current as…</button>
        </div>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => { onApply(l, name); onClose(); }}>Apply</button>
      </div>
    </Modal>
  );
}
