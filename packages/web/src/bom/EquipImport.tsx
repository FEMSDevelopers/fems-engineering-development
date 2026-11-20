import { guessSubcategory, parseEquipmentList, partKey, partMatcher, walk, type BomNode, type Grid, type Part } from "@fpl/core";
import { useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { Modal, useUi } from "../ui";
import type { Catalog } from "./shared";

interface Sheet {
  name: string;
  grid: Grid;
  ok: boolean;
  on: boolean;
  tag: string;
}
const isEquip = (g: Grid) => g.slice(0, 15).some((r) => r.some((c) => /^NO\.?$/i.test((c ?? "").trim())) && r.some((c) => (c ?? "").toUpperCase().replace(/[^A-Z]/g, "") === "PARTNUMBER"));
const titleTag = (g: Grid) => (g.slice(0, 5).flat().find((c) => /EQUIPMENT LIST/i.test(c ?? "")) ?? "").split(/[-–]\s*/).slice(1).join("-").trim();

/** Import equipment lists (drawing-set BOM sheets) as project units, rebuilding groups from the item numbers. */
export function EquipImport({ cat, onImport, onClose }: { cat: Catalog; onImport: (units: BomNode[]) => void; onClose: () => void }) {
  const ui = useUi();
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [keepNumbers, setKeepNumbers] = useState(true);
  const [addMissing, setAddMissing] = useState(true);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => {
    const match = partMatcher(cat.parts);
    return sheets.map((s) => {
      if (!s.ok || !s.on) return null;
      try {
        const r = parseEquipmentList(s.grid, { unitTag: s.tag || undefined, match, keepNumbers });
        let lines = 0;
        let linked = 0;
        walk([r.unit], (n) => n.kind === "part" && (lines++, n.partId && linked++));
        return { ...r, lines, linked };
      } catch (e) {
        return { error: errMsg(e) };
      }
    });
  }, [sheets, cat.parts, keepNumbers]);
  const missing = useMemo(() => {
    const have = new Set(cat.parts.map((p) => partKey(p.manufacturer, p.partNumber)));
    const m = new Map<string, { manufacturer: string; partNumber: string; description: string }>();
    for (const p of preview) if (p && "parts" in p) for (const s of p.parts) if (!have.has(partKey(s.manufacturer, s.partNumber))) m.set(partKey(s.manufacturer, s.partNumber), s);
    return [...m.values()];
  }, [preview, cat.parts]);

  const go = async () => {
    setBusy(true);
    try {
      let parts: Part[] = cat.parts;
      if (addMissing && missing.length) {
        const rows = missing.map((s) => {
          const sub = guessSubcategory(s.description, cat.subcats);
          return { ...s, subcategoryId: sub?.id ?? null, category: sub?.category ?? "" };
        });
        const r = await api.parts.import(rows, "skip");
        parts = await api.parts.list();
        ui.toast(`${r.created} part(s) added to the master list`);
        await cat.refresh();
      }
      const match = partMatcher(parts);
      const units = sheets.filter((s) => s.ok && s.on).map((s) => parseEquipmentList(s.grid, { unitTag: s.tag || undefined, match, keepNumbers }).unit);
      onImport(units);
      onClose();
    } catch (e) {
      ui.toast(`Import failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Import equipment list">
      <div className="mh"><h3>Import equipment lists</h3><span className="muted" style={{ fontSize: 12.5 }}>One unit per sheet (No. | MANUFACTURER | PART NUMBER | DESCRIPTION | QTY | PREFIX [| TOTAL]).</span></div>
      <div className="mb">
        <div className="toolbar">
          <label className="btn btn-primary">
            Open .xlsx…
            <input type="file" accept=".xlsx,.csv" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                const s = await api.parseFile(f);
                setSheets(s.map((x) => ({ name: x.name, grid: x.grid, ok: isEquip(x.grid), on: isEquip(x.grid), tag: titleTag(x.grid) })));
              } catch (er) {
                ui.toast(errMsg(er));
              }
            }} />
          </label>
          <label className="chk-l"><input type="checkbox" checked={keepNumbers} onChange={(e) => setKeepNumbers(e.target.checked)} /> Keep the sheet's item numbers where they differ from automatic numbering</label>
          <label className="chk-l"><input type="checkbox" checked={addMissing} onChange={(e) => setAddMissing(e.target.checked)} /> Add missing parts to the master list ({missing.length})</label>
        </div>
        {sheets.length > 0 && (
          <table className="mini wide">
            <thead><tr><th /><th>Sheet</th><th>Unit tag</th><th>Part lines</th><th>Linked to master parts</th><th>Notes</th></tr></thead>
            <tbody>
              {sheets.map((s, i) => {
                const pv = preview[i];
                return (
                  <tr key={i} className={s.ok ? undefined : "dim"}>
                    <td><input type="checkbox" disabled={!s.ok} checked={s.on} aria-label={`Import ${s.name}`} onChange={(e) => setSheets(sheets.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /></td>
                    <td>{s.name}</td>
                    <td><input type="text" className="mono" value={s.tag} disabled={!s.ok} onChange={(e) => setSheets(sheets.map((x, j) => (j === i ? { ...x, tag: e.target.value } : x)))} style={{ width: 120 }} /></td>
                    <td>{pv && "lines" in pv ? pv.lines : ""}</td>
                    <td>{pv && "lines" in pv ? `${pv.linked} / ${pv.lines}` : ""}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{!s.ok ? "Not an equipment list" : pv && "error" in pv ? pv.error : pv && "warnings" in pv ? pv.warnings.join("; ") : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="mf">
        <span className="info">Imported units are appended to the open project; save a version afterwards.</span>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !sheets.some((s) => s.ok && s.on)} onClick={go}>Import {sheets.filter((s) => s.ok && s.on).length} unit(s)</button>
      </div>
    </Modal>
  );
}
