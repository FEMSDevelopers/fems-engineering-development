import { guessSubcategory, normName, parseDelimited, parseTag, partKey, type Grid, type Part, type Subcategory } from "@fpl/core";
import { useMemo, useState } from "react";
import { api, errMsg } from "../api";
import { Modal, useUi } from "../ui";

interface Target {
  key: string;
  label: string;
  syn: string[];
}
/** Columns of the master parts list (and of drawing-set equipment lists). */
const TARGETS: Target[] = [
  { key: "manufacturer", label: "Manufacturer", syn: ["manufacturer", "mfr", "make", "brand"] },
  { key: "partNumber", label: "Part number", syn: ["partnumber", "pn", "partno", "part", "catalognumber", "model"] },
  { key: "description", label: "Description", syn: ["description", "desc"] },
  { key: "series", label: "Product series", syn: ["series", "productseries", "family"] },
  { key: "sku", label: "SKU", syn: ["sku", "ordercode", "orderingcode", "catalognumber", "catalogno"] },
  { key: "configCode1", label: "Configuration code #1", syn: ["configcode1", "configurationcode1", "configurationcode", "configcode"] },
  { key: "configCode2", label: "Configuration code #2", syn: ["configcode2", "configurationcode2"] },
  { key: "configCode3", label: "Configuration code #3", syn: ["configcode3", "configurationcode3"] },
  { key: "category", label: "Category", syn: ["category", "devicecategory"] },
  { key: "subcategory", label: "Subcategory", syn: ["subcategory", "type"] },
  { key: "group", label: "Assembly / group (for guessing)", syn: ["assembly", "group"] },
  { key: "vendor", label: "Typical vendor(s)", syn: ["typicalvendors", "vendor", "vendors", "supplier", "typicalvendor"] },
  { key: "vendorContact", label: "Vendor contact", syn: ["vendorcontact", "contact"] },
  { key: "notes", label: "Notes", syn: ["notes", "note", "comments"] },
  { key: "oemDesc", label: "OEM desc", syn: ["oemdesc", "oemdescription", "longdescription", "fulldescription"] },
  { key: "stock", label: "In stock", syn: ["countinstock", "stock", "instock", "onhand", "qtyinstock"] },
  { key: "onOrder", label: "On order", syn: ["countonorder", "onorder"] },
  { key: "price", label: "Unit price", syn: ["price", "unitprice", "cost", "unitcost"] },
  { key: "weightKg", label: "Weight (kg)", syn: ["weight", "weightkg"] },
  { key: "tagPrefix", label: "Tag prefix", syn: ["prefix", "tagprefix"] },
];
const norm = (h: string) => normName(h).replace(/\d+$/, "");
const numOrNull = (s: string) => {
  const t = (s ?? "").replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
};

/** Import parts from the master parts list (or any sheet with manufacturer / part number columns). */
export function PartImport({ parts, subcats, onDone, onClose }: { parts: Part[]; subcats: Subcategory[]; onDone: () => void; onClose: () => void }) {
  const ui = useUi();
  const [sheets, setSheets] = useState<{ name: string; grid: Grid }[]>([]);
  const [si, setSi] = useState(0);
  const [hdr, setHdr] = useState(0);
  const [map, setMap] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [guess, setGuess] = useState(true);
  const [busy, setBusy] = useState(false);
  const grid = sheets[si]?.grid ?? [];

  const load = (list: { name: string; grid: Grid }[]) => {
    setSheets(list);
    setSi(0);
    pick(list[0]?.grid ?? []);
  };
  /** Header row = first row with at least 2 recognised column names; columns auto-mapped by synonyms. */
  const pick = (g: Grid) => {
    let h = g.findIndex((r) => r.filter((c) => TARGETS.some((t) => t.syn.includes(norm(c)))).length >= 2);
    if (h < 0) h = 0;
    setHdr(h);
    setMap(autoMap(g[h] ?? []));
  };
  const autoMap = (head: string[]) => {
    const m: Record<string, number> = {};
    const used = new Set<number>();
    for (const t of TARGETS) {
      const j = head.findIndex((c, k) => !used.has(k) && t.syn.includes(norm(c)));
      if (j >= 0) (used.add(j), (m[t.key] = j));
    }
    return m;
  };

  const exist = useMemo(() => new Set(parts.map((p) => partKey(p.manufacturer, p.partNumber))), [parts]);
  const rows = useMemo(() => {
    const head = grid[hdr] ?? [];
    if (!head.length) return [];
    const v = (r: string[], k: string) => (map[k] != null && map[k] >= 0 ? (r[map[k]] ?? "").trim() : "");
    return grid
      .slice(hdr + 1)
      .filter((r) => v(r, "partNumber"))
      .map((r) => {
        const subName = v(r, "subcategory");
        let sub = subName ? subcats.find((s) => s.name.toLowerCase() === subName.toLowerCase()) : undefined;
        if (!sub && guess) sub = guessSubcategory([`${subName} ${v(r, "group")}`, v(r, "description")], subcats);
        const w = numOrNull(v(r, "weightKg"));
        const pre = parseTag(v(r, "tagPrefix")).tag;
        const notes = [v(r, "notes"), subName && !sub ? `Type: ${subName}` : "", v(r, "group") && !sub ? `Assembly: ${v(r, "group")}` : ""].filter(Boolean).join(" · ");
        const p: Partial<Part> = {
          manufacturer: v(r, "manufacturer"), partNumber: v(r, "partNumber"), description: v(r, "description"), series: v(r, "series"), sku: v(r, "sku"), configCode1: v(r, "configCode1"), configCode2: v(r, "configCode2"), configCode3: v(r, "configCode3"),
          category: v(r, "category") || sub?.category || "", subcategoryId: sub?.id ?? null,
          vendor: v(r, "vendor"), vendorContact: v(r, "vendorContact"), notes, oemDesc: v(r, "oemDesc"),
          stock: numOrNull(v(r, "stock")), onOrder: numOrNull(v(r, "onOrder")), price: numOrNull(v(r, "price")),
          tagPrefix: pre && pre !== sub?.tagPrefix ? pre : "",
          ...(w != null ? { mech: { mount: "", rackUnits: null, widthMm: null, heightMm: null, depthMm: null, dinWidthMm: null, weightKg: w } } : {}),
        };
        return { p, sub, dup: exist.has(partKey(p.manufacturer ?? "", p.partNumber ?? "")) };
      });
  }, [grid, hdr, map, subcats, guess, exist]);
  // Collapse duplicates inside the file (same manufacturer + part number): first row wins.
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = partKey(r.p.manufacturer ?? "", r.p.partNumber ?? "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [rows]);
  const nDup = unique.filter((r) => r.dup).length;

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.parts.import(unique.map((x) => x.p), mode);
      ui.toast(`Imported: ${r.created} new, ${r.updated} updated, ${r.skipped} skipped`);
      onDone();
      onClose();
    } catch (e) {
      ui.toast(`Import failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const head = grid[hdr] ?? [];

  return (
    <Modal onClose={onClose} label="Import parts">
      <div className="mh"><h3>Import parts</h3><span className="muted" style={{ fontSize: 12.5 }}>Master parts list, an equipment list, or any sheet with Manufacturer and Part number columns.</span></div>
      <div className="mb">
        <div className="toolbar">
          <label className="btn">
            Open .xlsx / .csv…
            <input type="file" accept=".xlsx,.csv,.txt" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                load(await api.parseFile(f));
              } catch (er) {
                ui.toast(errMsg(er));
              }
            }} />
          </label>
          <span className="muted">or paste:</span>
          <textarea rows={1} style={{ flex: 1, fontFamily: "var(--f-mono)", fontSize: 12 }} placeholder="Click and press Ctrl+V (with the header row)" value="" onChange={(e) => e.target.value.trim() && load([{ name: "Pasted", grid: parseDelimited(e.target.value) }])} />
        </div>
        {sheets.length > 0 && (
          <>
            <div className="frow tight">
              {sheets.length > 1 && (
                <label className="f">Sheet
                  <select value={si} onChange={(e) => (setSi(Number(e.target.value)), pick(sheets[Number(e.target.value)].grid))}>
                    {sheets.map((s, i) => <option key={i} value={i}>{s.name} ({s.grid.length} rows)</option>)}
                  </select>
                </label>
              )}
              <label className="f">Header row
                <select value={hdr} onChange={(e) => (setHdr(Number(e.target.value)), setMap(autoMap(grid[Number(e.target.value)] ?? [])))}>
                  {grid.slice(0, 15).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter(Boolean).slice(0, 4).join(" | ").slice(0, 70)}</option>)}
                </select>
              </label>
              <label className="f">Existing parts (same manufacturer + part number)
                <select value={mode} onChange={(e) => setMode(e.target.value as "skip" | "update")}>
                  <option value="skip">Skip</option>
                  <option value="update">Update with non-empty values</option>
                </select>
              </label>
              <label className="chk-l" style={{ alignSelf: "flex-end" }}><input type="checkbox" checked={guess} onChange={(e) => setGuess(e.target.checked)} /> Guess subcategory from type / description</label>
            </div>
            <div className="mapgrid">
              {TARGETS.map((t) => (
                <label key={t.key} className="f">
                  {t.label}
                  <select value={map[t.key] ?? -1} onChange={(e) => setMap({ ...map, [t.key]: Number(e.target.value) })}>
                    <option value={-1}>—</option>
                    {head.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="preview">
              <table className="mini wide">
                <thead><tr><th>Manufacturer</th><th>Part number</th><th>Description</th><th>Subcategory</th><th>Stock</th><th /></tr></thead>
                <tbody>
                  {unique.slice(0, 200).map((r, i) => (
                    <tr key={i}>
                      <td>{r.p.manufacturer}</td><td className="mono">{r.p.partNumber}</td><td className="clip">{r.p.description}</td>
                      <td>{r.sub ? r.sub.name : <span className="muted">—</span>}</td><td>{r.p.stock ?? ""}</td>
                      <td>{r.dup && <span className="chip">{mode === "skip" ? "exists · skip" : "exists · update"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="mf">
        <span className="info">{sheets.length ? `${unique.length} parts (${rows.length - unique.length} repeated rows merged) · ${nDup} already in the catalog` : ""}</span>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !unique.length} onClick={go}>Import {unique.length} parts</button>
      </div>
    </Modal>
  );
}
