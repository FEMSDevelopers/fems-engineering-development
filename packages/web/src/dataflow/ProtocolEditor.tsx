import { DEFAULT_STYLE, type ProtocolDef, type ProtocolStyle } from "@fpl/core";
import { useState } from "react";
import { api, errMsg } from "../api";
import { Modal, useUi } from "../ui";
import { DASHES, HEADS, LinePreview, orderedProtocols } from "./draw";

type Draft = ProtocolDef & { isNew?: boolean; del?: boolean };
const PALETTE = ["#0b6e69", "#7a3e9d", "#b0490f", "#1d5fa8", "#9a5800", "#3d7a2a", "#b3261e", "#5b6872"];

/** Add / rename / delete protocols and set how each one is drawn. Changes apply on "Save changes". */
export function ProtocolEditor({ protocols, usage, onClose, onSaved }: { protocols: ProtocolDef[]; usage: Record<string, number>; onClose: () => void; onSaved: () => void }) {
  const ui = useUi();
  const [rows, setRows] = useState<Draft[]>(() => orderedProtocols(protocols).map(({ depth: _d, ...p }) => ({ ...p, style: { ...p.style } })));
  const [busy, setBusy] = useState(false);
  const set = (id: string, patch: Partial<Draft>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const setStyle = (id: string, patch: Partial<ProtocolStyle>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, style: { ...x.style, ...patch } } : x)));
  const orig = new Map(protocols.map((p) => [p.id, p]));

  const add = () => {
    const id = `new-${Date.now()}`;
    const color = PALETTE[rows.length % PALETTE.length];
    setRows([...rows, { id, isNew: true, name: "", alias: "", dfAlias: "", parentId: null, defaultPort: "", pointListKind: "", style: { ...DEFAULT_STYLE, color }, sort: (rows.at(-1)?.sort ?? 0) + 10 }]);
  };

  const save = async () => {
    const live = rows.filter((r) => !r.del);
    if (live.some((r) => !r.name.trim())) return ui.toast("Every protocol needs a name");
    const names = live.map((r) => r.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) return ui.toast("Protocol names must be unique");
    setBusy(true);
    const problems: string[] = [];
    try {
      const idMap = new Map<string, string>();
      // 1) create new ones (parents resolved after), 2) update changed, 3) delete marked
      for (const r of live.filter((x) => x.isNew)) {
        const c = await api.protocols.create({ name: r.name.trim(), alias: r.alias, dfAlias: r.dfAlias, defaultPort: r.defaultPort, pointListKind: r.pointListKind, style: r.style, sort: r.sort });
        idMap.set(r.id, c.id);
      }
      for (const r of live) {
        const id = idMap.get(r.id) ?? r.id;
        const parentId = r.parentId ? idMap.get(r.parentId) ?? r.parentId : null;
        const body = { name: r.name.trim(), alias: r.alias, dfAlias: r.dfAlias, parentId, defaultPort: r.defaultPort, pointListKind: r.pointListKind, style: r.style, sort: r.sort };
        if (r.isNew) {
          if (parentId) await api.protocols.update(id, { parentId });
          continue;
        }
        const o = orig.get(r.id)!;
        const before = { name: o.name, alias: o.alias, dfAlias: o.dfAlias, parentId: o.parentId, defaultPort: o.defaultPort, pointListKind: o.pointListKind, style: o.style, sort: o.sort };
        if (JSON.stringify(before) === JSON.stringify(body)) continue;
        try {
          await api.protocols.update(id, body);
        } catch (e) {
          problems.push(`${r.name}: ${errMsg(e)}`);
        }
      }
      for (const r of rows.filter((x) => x.del && !x.isNew)) {
        try {
          await api.protocols.remove(r.id);
        } catch (e) {
          problems.push(`${r.name}: ${errMsg(e)}`);
        }
      }
      onSaved();
      if (problems.length) ui.toast(problems.join(" · "));
      else {
        ui.toast("Protocols saved");
        onClose();
      }
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || lo));
  return (
    <Modal onClose={onClose} label="Edit protocols">
      <div className="mh">
        <h3>Protocols</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>Name, alias and DF alias (short text used in data flows and diagram labels). Line style applies to the diagram.</span>
      </div>
      <div className="mb">
        <div style={{ overflowX: "auto" }}>
          <table className="vt proto-ed">
            <thead>
              <tr>
                <th>Name</th><th>Alias</th><th>DF alias</th><th>Parent</th><th>Default port</th><th>Point list</th>
                <th>Line</th><th>Color</th><th>Width</th><th>Type</th><th>Start head</th><th>End head</th><th>Scale</th><th>Opacity</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.del ? "del" : undefined}>
                  <td><input type="text" aria-label="Name" value={r.name} onChange={(e) => set(r.id, { name: e.target.value })} style={{ width: 150 }} /></td>
                  <td><input type="text" aria-label="Alias" value={r.alias} onChange={(e) => set(r.id, { alias: e.target.value })} style={{ width: 110 }} /></td>
                  <td><input type="text" aria-label="DF alias" value={r.dfAlias} maxLength={20} onChange={(e) => set(r.id, { dfAlias: e.target.value })} style={{ width: 70 }} className="mono" /></td>
                  <td>
                    <select aria-label="Parent" value={r.parentId ?? ""} onChange={(e) => set(r.id, { parentId: e.target.value || null })}>
                      <option value="">—</option>
                      {rows.filter((x) => x.id !== r.id && !x.del).map((x) => <option key={x.id} value={x.id}>{x.name || "(new)"}</option>)}
                    </select>
                  </td>
                  <td><input type="text" aria-label="Default port" value={r.defaultPort} onChange={(e) => set(r.id, { defaultPort: e.target.value.replace(/\D/g, "") })} style={{ width: 64 }} className="mono" /></td>
                  <td>
                    <select aria-label="Point list type" value={r.pointListKind} onChange={(e) => set(r.id, { pointListKind: e.target.value as ProtocolDef["pointListKind"] })}>
                      <option value="">{r.parentId ? "(inherit)" : "—"}</option>
                      <option value="modbus">Modbus</option><option value="dnp3">DNP3</option><option value="iec104">IEC 104</option>
                    </select>
                  </td>
                  <td><LinePreview p={r} width={110} /></td>
                  <td><input type="color" aria-label="Color" value={r.style.color} onChange={(e) => setStyle(r.id, { color: e.target.value })} /></td>
                  <td><input type="number" aria-label="Width" min={0.5} max={12} step={0.5} value={r.style.width} onChange={(e) => setStyle(r.id, { width: num(e.target.value, 0.5, 12) })} style={{ width: 56 }} /></td>
                  <td><select aria-label="Line type" value={r.style.dash} onChange={(e) => setStyle(r.id, { dash: e.target.value as ProtocolStyle["dash"] })}>{DASHES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                  <td><select aria-label="Start head" value={r.style.startHead} onChange={(e) => setStyle(r.id, { startHead: e.target.value as ProtocolStyle["startHead"] })}>{HEADS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                  <td><select aria-label="End head" value={r.style.endHead} onChange={(e) => setStyle(r.id, { endHead: e.target.value as ProtocolStyle["endHead"] })}>{HEADS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                  <td><input type="number" aria-label="Scale" min={0.25} max={4} step={0.25} value={r.style.scale} onChange={(e) => setStyle(r.id, { scale: num(e.target.value, 0.25, 4) })} style={{ width: 56 }} /></td>
                  <td><input type="number" aria-label="Opacity" min={0.1} max={1} step={0.1} value={r.style.opacity} onChange={(e) => setStyle(r.id, { opacity: num(e.target.value, 0.1, 1) })} style={{ width: 56 }} /></td>
                  <td>
                    <button type="button" className="btn-danger" disabled={!r.del && (usage[r.id] ?? 0) > 0} title={(usage[r.id] ?? 0) > 0 ? `Used by ${usage[r.id]} connection(s)` : undefined} onClick={() => (r.isNew ? setRows(rows.filter((x) => x.id !== r.id)) : set(r.id, { del: !r.del }))}>
                      {r.del ? "Undo" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div><button type="button" onClick={add}>Add protocol</button></div>
      </div>
      <div className="mf">
        <span className="info">Start head = From (client/master) end · End head = To (server/outstation) end. Bidirectional connections use the end head on both ends.</span>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>Save changes</button>
      </div>
    </Modal>
  );
}
