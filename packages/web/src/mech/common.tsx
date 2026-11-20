import {
  cloneNode, deviceTag, devsOf, labelAnchor, LABEL_POS, nextNumbers, findNode, insertNode, itemNumbers, nodeIdentity, partNode, removeNode, updateNode, walk,
  type BomNode, type DeviceEntry, type DeviceId, type LabelPos, type PartLabel, type MechIssue, type Overlay, type PartView, type ViewName,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { viewSrc } from "../bom/viewCache";
import { NumIn, fmtN, type Catalog } from "../bom/shared";
import { PartPicker } from "../bom/TreeEditor";
import { Modal, useLocal } from "../ui";

export { invalidateViews, useViews } from "../bom/viewCache";

export const viewHref = (v: PartView | undefined) => (v ? viewSrc(v) : undefined);

// ───────── units of length ─────────

export function useLen() {
  const [unit, setUnit] = useLocal<"mm" | "in">("fpl.mech.unit", "mm");
  const f = unit === "in" ? 25.4 : 1;
  return {
    unit, setUnit,
    fmt: (mm: number | null | undefined, d = unit === "in" ? 2 : 0) => (mm == null ? "" : `${fmtN(mm / f, d)}${unit === "in" ? " in" : " mm"}`),
    toUser: (mm: number | null | undefined) => (mm == null ? null : Math.round((mm / f) * 10000) / 10000),
    fromUser: (v: number | null) => (v == null ? null : v * f),
  };
}
export type Len = ReturnType<typeof useLen>;
/** Length input in the chosen unit, stored in mm. */
export function LenIn({ len, value, onChange, label, width = 80 }: { len: Len; value: number | null | undefined; onChange: (mm: number | null) => void; label: string; width?: number }) {
  return <NumIn label={label} value={len.toUser(value)} onChange={(v) => onChange(len.fromUser(v))} width={width} />;
}

// ───────── SVG canvas helpers ─────────

/** Client point → SVG user units (mm). */
export function svgPoint(svg: SVGSVGElement | null, clientX: number, clientY: number): { x: number; y: number } {
  if (!svg) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = pt.matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

/** Zoom (px per mm) with +/−/fit controls. */
export function useZoom(key: string, init = 1) {
  const [z, setZ] = useLocal<number>(`fpl.mech.zoom.${key}`, init);
  const wrap = useRef<HTMLDivElement>(null);
  const fit = (wMm: number, hMm: number) => {
    const el = wrap.current;
    if (!el) return;
    setZ(Math.max(0.1, Math.min(8, Math.min((el.clientWidth - 30) / wMm, (el.clientHeight - 30) / hMm))));
  };
  const controls = (wMm: number, hMm: number) => (
    <span className="zoomctl">
      <button type="button" className="btn-ghost" aria-label="Zoom out" onClick={() => setZ(Math.max(0.1, z / 1.25))}>−</button>
      <span className="mono">{Math.round(z * 100)}%</span>
      <button type="button" className="btn-ghost" aria-label="Zoom in" onClick={() => setZ(Math.min(8, z * 1.25))}>+</button>
      <button type="button" className="btn-ghost" onClick={() => fit(wMm, hMm)}>Fit</button>
    </span>
  );
  return { z, setZ, wrap, fit, controls };
}

export function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
/** Save an on-screen drawing as a standalone SVG (mm units, white background). */
export function downloadSvg(svg: SVGSVGElement | null, name: string) {
  if (!svg) return;
  const c = svg.cloneNode(true) as SVGSVGElement;
  const vb = c.viewBox.baseVal;
  c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  c.setAttribute("width", `${vb.width}mm`);
  c.setAttribute("height", `${vb.height}mm`);
  c.querySelectorAll("[data-ui]").forEach((n) => n.remove());
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", String(vb.x));
  bg.setAttribute("y", String(vb.y));
  bg.setAttribute("width", String(vb.width));
  bg.setAttribute("height", String(vb.height));
  bg.setAttribute("fill", "#fff");
  c.insertBefore(bg, c.firstChild);
  download(name, `<?xml version="1.0" encoding="UTF-8"?>\n${c.outerHTML}`, "image/svg+xml");
}

export const DT_MECH = "application/x-fpl-mech";
export type MechDrag = { t: "node"; nodeId: string; inst: number };

// ───────── issues ─────────

export function IssueList({ issues, onPick }: { issues: MechIssue[]; onPick?: (id: string) => void }) {
  if (!issues.length) return <p className="muted okline">No problems found</p>;
  return (
    <ul className="missues">
      {issues.map((i, k) => (
        <li key={k} className={`lvl-${i.level}`}>
          <button type="button" className="btn-ghost" disabled={!i.id || !onPick} onClick={() => i.id && onPick?.(i.id)}>
            {i.level === "error" ? "✖" : "▲"} {i.msg}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ───────── shift prompt (rack) ─────────

export function ShiftPrompt({ label, h, onDone }: { label: string; h: number; onDone: (r: { mode: "up" | "down" | "overlap"; gap: number } | null) => void }) {
  const [mode, setMode] = useState<"up" | "down" | "overlap">("up");
  const [gap, setGap] = useState(0);
  return (
    <Modal size="sm" onClose={() => onDone(null)} label="Make room">
      <div className="mh"><h3>Make room for {label}</h3></div>
      <div className="mb">
        <p style={{ margin: 0 }}>The position is taken. Shift the equipment there by <b>{h}U</b> (the size of {label}){gap ? <> plus <b>{gap}U</b> empty above it</> : null}:</p>
        <div className="seg" role="group" aria-label="Direction">
          <button type="button" aria-pressed={mode === "up"} onClick={() => setMode("up")}>↑ Shift upward</button>
          <button type="button" aria-pressed={mode === "down"} onClick={() => setMode("down")}>↓ Shift downward</button>
          <button type="button" aria-pressed={mode === "overlap"} onClick={() => setMode("overlap")}>Place overlapping</button>
        </div>
        <label className="f">Empty space above {label}
          <select value={gap} onChange={(e) => setGap(Number(e.target.value))} disabled={mode === "overlap"}>
            <option value={0}>None</option><option value={1}>1U</option><option value={2}>2U</option>
          </select>
        </label>
      </div>
      <div className="mf">
        <button type="button" onClick={() => onDone(null)}>Cancel</button>
        <button type="button" className="btn-primary" autoFocus onClick={() => onDone({ mode, gap })}>Place</button>
      </div>
    </Modal>
  );
}

// ───────── a unit's bill of materials (change part numbers, quantities; add / delete lines) ─────────

export function UnitBom({ unit, setUnit, cat, focus }: { unit: BomNode; setUnit: (f: (u: BomNode) => BomNode) => void; cat: Catalog; focus?: string | null }) {
  const nos = useMemo(() => itemNumbers([unit]), [unit]);
  const [pick, setPick] = useState<{ mode: "change"; id: string } | { mode: "add" } | null>(null);
  const groups = useMemo(() => {
    const g: { id: string; label: string }[] = [];
    walk(unit.children, (n, ps) => n.kind === "group" && !n.line && g.push({ id: n.id, label: `${"· ".repeat(ps.length)}${nos.get(n.id) ?? ""} ${n.name || n.tags[0] || "(group)"}` }));
    return g;
  }, [unit, nos]);
  const [target, setTarget] = useState<string>("");
  const lines: BomNode[] = [];
  walk(unit.children, (n) => n.kind === "part" && lines.push(n));
  const edit = (id: string, f: (n: BomNode) => BomNode) => setUnit((u) => ({ ...u, children: updateNode(u.children, id, f) }));
  return (
    <div className="unitbom">
      <div className="toolbar sub">
        <b>{unit.tags[0] ? `+${unit.tags[0]}` : unit.name} bill of material</b>
        <span className="grow" />
        <select aria-label="Add into group" value={target} onChange={(e) => setTarget(e.target.value)} style={{ maxWidth: 170 }}>
          <option value="">into: (first group)</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
        <button type="button" onClick={() => setPick({ mode: "add" })}>+ Part</button>
      </div>
      <div className="scroll">
        <table className="mini wide">
          <thead><tr><th>No.</th><th>Part</th><th>Qty</th><th>Tags</th><th /></tr></thead>
          <tbody>
            {lines.map((n) => {
              const id = nodeIdentity(n, cat.ctx);
              return (
                <tr key={n.id} className={focus === n.id ? "sel" : undefined}>
                  <td className="mono muted">{nos.get(n.id)}</td>
                  <td title={id.description}><span className="mono">{id.partNumber}</span> <span className="muted">{id.manufacturer}</span><div className="muted clipd">{id.description}</div></td>
                  <td><NumIn label="Quantity" value={n.qty} width={48} onChange={(v) => edit(n.id, (x) => ({ ...x, qty: Math.max(0, v ?? 0) }))} /></td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{n.tags.join(", ")}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="btn-ghost" title="Change part number (e.g. 20 A → 25 A breaker)" onClick={() => setPick({ mode: "change", id: n.id })}>Change…</button>
                    <button type="button" className="btn-ghost btn-danger" aria-label="Delete line" onClick={() => setUnit((u) => ({ ...u, children: removeNode(u.children, n.id) }))}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pick && (
        <Modal onClose={() => setPick(null)} label="Pick a part">
          <div className="mh"><h3>{pick.mode === "add" ? "Add a part" : `Change ${nodeIdentity(findNode([unit], pick.id)?.node ?? unit, cat.ctx).partNumber}`}</h3></div>
          <div className="mb" style={{ minHeight: 360 }}>
            <PartPicker
              parts={cat.parts}
              cat={cat}
              empty="No parts match"
              onPick={(p) => {
                if (pick.mode === "change") edit(pick.id, (x) => ({ ...x, partId: p.id, snap: { manufacturer: p.manufacturer, partNumber: p.partNumber, description: p.description } }));
                else {
                  const into = target || groups[0]?.id || null;
                  const node = partNode(p, 1);
                  setUnit((u) => (into ? { ...u, children: insertNode(u.children, into, node) } : { ...u, children: [...u.children, node] }));
                }
                setPick(null);
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Palette entry: one BOM line with its unplaced units, draggable onto a drawing. */
export function PaletteItem({ n, cat, left, total, extra, onDragStart, sel, onClick }: { n: BomNode; cat: Catalog; left: number[]; total: number; extra?: string; onDragStart: (inst: number) => (e: React.DragEvent) => void; sel?: boolean; onClick?: () => void }) {
  const id = nodeIdentity(n, cat.ctx);
  const next = left[0];
  return (
    <li className={`pal${left.length ? "" : " done"}${sel ? " sel" : ""}`} draggable={left.length > 0} onDragStart={next != null ? onDragStart(next) : undefined} onClick={onClick} title={left.length ? "Drag onto the drawing" : "All placed"}>
      <span className="nm">{n.kind === "group" ? <b>{n.name || n.tags[0] || "assembly"}</b> : <span className="mono">{id.partNumber}</span>}{n.tags[next ?? 0] && <span className="mono tagc"> -{n.tags[next ?? 0]}</span>}</span>
      <span className="meta"><span className="clip">{n.kind === "group" ? `${n.children.length} lines` : id.description}</span><span className="cnt">{total - left.length}/{total}{extra ? ` · ${extra}` : ""}</span></span>
    </li>
  );
}

// ───────── BOM reference overlay (device tags, red / yellow status, links) ─────────

export type Ov = Overlay;

/** Device tags of one placed unit of a layout line: from the referenced project BOM, else the layout line's own tags. */
export function tagsOf(ov: Overlay | undefined, n: BomNode, inst: number, pin?: { id: string; inst: number } | null): string[] {
  if (ov?.hasRef) return ov.tags(n.id, inst, pin);
  return n.tags[inst] ? [`-${n.tags[inst]}`] : n.kind === "group" && n.tags[0] ? [`-${n.tags[0]}`] : [];
}
export const stOf = (ov: Overlay | undefined, id: string) => (ov?.hasRef ? ov.status.get(id) ?? "ok" : "ok");

/** Adjustable width of the equipment list (drag the handle on its right edge). */
export function useSplit(key: string, init = 300, initRight = 360) {
  const [w, setW] = useLocal<number>(`fpl.mech.split.${key}`, init);
  const [rw, setRw] = useLocal<number>(`fpl.mech.split.${key}.right`, initRight);
  const drag = (get: number, set: (v: number) => void, dir: 1 | -1, min: number, max: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => set(Math.max(min, Math.min(max, get + dir * (ev.clientX - x0))));
    const up = () => (el.removeEventListener("pointermove", mv), el.removeEventListener("pointerup", up));
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
  };
  const handle = (
    <div className="splitter" role="separator" aria-orientation="vertical" aria-label="Resize equipment list" title="Drag to resize (double-click: default)"
      onPointerDown={drag(w, setW, 1, 200, 900)} onDoubleClick={() => setW(init)} />
  );
  /** Handle on the left edge of the right panel. */
  const rightHandle = (
    <div className="splitter left" role="separator" aria-orientation="vertical" aria-label="Resize the right panel" title="Drag to resize (double-click: default)"
      onPointerDown={drag(rw, setRw, -1, 280, 1000)} onDoubleClick={() => setRw(initRight)} />
  );
  return { w, rw, handle, rightHandle, cols: `${w}px minmax(0, 1fr) ${rw}px` };
}

export interface EquipRow {
  n: BomNode;
  left: number[];
  total: number;
  size?: string;
}
/** Equipment list: one draggable row per layout line, with the BOM overlay (status, BOM qty, device tags). */
export function EquipTable({ rows, cat, ov, sel, onPick, onDragStart, empty }: {
  rows: EquipRow[]; cat: Catalog; ov?: Overlay; sel?: string | null; onPick?: (n: BomNode) => void;
  onDragStart: (n: BomNode, inst: number) => (e: React.DragEvent) => void; empty?: React.ReactNode;
}) {
  if (!rows.length) return <p className="muted" style={{ padding: 10, fontSize: 12.5, margin: 0 }}>{empty}</p>;
  return (
    <table className="mini wide equip">
      <thead><tr><th aria-label="Status" /><th>Manufacturer</th><th>Part number</th><th className="c-desc">Description</th><th>Size</th><th title="Placed / listed in the layout">Placed</th>{ov?.hasRef && <th title="Quantity on the referenced project BOM (per unit)">BOM</th>}<th>Tags</th></tr></thead>
      <tbody>
        {rows.map(({ n, left, total, size }) => {
          const id = nodeIdentity(n, cat.ctx);
          const st = stOf(ov, n.id);
          const next = left[0];
          const tags = tagsOf(ov, n, next ?? 0);
          const bq = ov?.bomQty.get(n.id);
          return (
            <tr key={n.id} className={`st-${st}${left.length ? "" : " done"}${sel === n.id ? " sel" : ""}`} draggable={left.length > 0} onDragStart={next != null ? onDragStart(n, next) : undefined} onClick={() => onPick?.(n)}
              title={st === "missing" ? "Not on the referenced project BOM any more" : st === "short" ? "Fewer placed than the project BOM quantity" : left.length ? "Drag onto the drawing" : "All placed"}>
              <td><span className={`stdot st-${st}`} /></td>
              <td className="clipc">{n.kind === "group" ? <span className="muted">assembly</span> : id.manufacturer}</td>
              <td className="mono">{n.kind === "group" ? <b>{n.alias || n.name || n.tags[0] || "assembly"}</b> : id.partNumber}</td>
              <td className="c-desc clipc" title={id.description}>{n.kind === "group" ? `${n.children.length} lines` : id.description}</td>
              <td className="mono muted">{size ?? ""}</td>
              <td className="mono">{total - left.length}/{total}</td>
              {ov?.hasRef && <td className="mono">{bq ?? "—"}</td>}
              <td className="mono tagc">{tags.slice(0, 4).join(" ")}{tags.length > 4 ? " …" : ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** BOM lines of the referenced unit that the layout does not cover; Add copies them (linked) into the layout. */
export function NotInLayout({ ov, cat, onAdd }: { ov?: Overlay; cat: Catalog; onAdd: (b: BomNode, qty: number) => void }) {
  if (!ov?.hasRef || !ov.notInLayout.length) return null;
  return (
    <>
      <div className="pane-head"><h3>On the BOM, not in this layout</h3><span className="muted">{ov.notInLayout.length}</span></div>
      <div className="scroll" style={{ maxHeight: 180 }}>
        <table className="mini wide equip">
          <tbody>
            {ov.notInLayout.map(({ node: b, missing }) => {
              const id = nodeIdentity(b, cat.ctx);
              return (
                <tr key={b.id} className="st-short">
                  <td><span className="stdot st-short" /></td>
                  <td className="clipc">{id.manufacturer}</td>
                  <td className="mono">{id.partNumber}</td>
                  <td className="mono tagc">{b.tags.slice(0, 3).map((t) => `-${t}`).join(" ")}</td>
                  <td className="mono">× {missing}</td>
                  <td><button type="button" className="btn-ghost" onClick={() => onAdd(b, missing)}>Add</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Copy a BOM line into a layout unit, linked to it. */
export function addFromBom(u: BomNode, b: BomNode, qty: number): BomNode {
  const c = cloneNode(b);
  const linked = { ...c, qty: c.kind === "part" ? qty : c.qty, bomNodeId: b.id, links: [b.id] };
  return { ...u, children: [...u.children, linked] };
}

/** Tag bubbles centred on a drawn box (SVG user units = mm). */
export function TagBubbles({ cx, cy, tags, maxW, size: size0 = 12 }: { cx: number; cy: number; tags: string[]; maxW: number; size?: number }) {
  const [st] = useMechSettings();
  if (!tags.length) return null;
  const size = size0 * (st.bubScale || 1);
  const cw = size * 0.62;
  const ws = tags.map((t) => t.length * cw + size);
  const gap = size * 0.35;
  // Rows that fit the box width.
  const rows: number[][] = [[]];
  let acc = 0;
  ws.forEach((w, i) => {
    if (rows[rows.length - 1].length && acc + gap + w > maxW) (rows.push([]), (acc = 0));
    rows[rows.length - 1].push(i);
    acc += (acc ? gap : 0) + w;
  });
  const h = size * 1.5;
  const y0 = cy - (rows.length * h + (rows.length - 1) * gap) / 2;
  return (
    <g className="tagbub" pointerEvents="none">
      {rows.map((r, ri) => {
        const rw = r.reduce((s, i) => s + ws[i], 0) + gap * (r.length - 1);
        let x = cx - rw / 2;
        return r.map((i) => {
          const x0 = x;
          x += ws[i] + gap;
          const y = y0 + ri * (h + gap);
          return (
            <g key={i}>
              <rect x={x0} y={y} width={ws[i]} height={h} rx={Math.min(1.5, h * 0.08)} fill={st.bubFill} stroke={st.bubStroke} strokeWidth={1} />
              <text x={x0 + ws[i] / 2} y={y + h / 2 + size * 0.36} textAnchor="middle" fill={st.bubText} fontWeight={st.bubWeight} fontStyle={st.bubItalic ? "italic" : undefined}
                fontFamily={st.bubFont === "mono" ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : "system-ui, -apple-system, Segoe UI, sans-serif"} style={{ fontSize: size }}>{tags[i]}</text>
            </g>
          );
        });
      })}
    </g>
  );
}

/** Links of a layout line to items of the referenced project BOM unit (groups, sub-assemblies, parts). */
export function LinkBox({ node, bomUnit, cat, onChange }: { node: BomNode; bomUnit: BomNode | null; cat: Catalog; onChange: (links: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const links = node.links ?? [];
  if (!bomUnit) return <p className="muted" style={{ margin: 0, fontSize: 12 }}>Set a BOM reference (toolbar) to link this line to project BOM items and show their device tags.</p>;
  const label = (b: BomNode) => (b.kind === "part" ? `${nodeIdentity(b, cat.ctx).partNumber}${b.tags.length ? ` (${b.tags.map((t) => `-${t}`).join(", ")})` : ""}` : `${b.line ? "Sub-assembly" : "Group"} ${b.alias || b.name || ""}${b.tags[0] ? ` -${b.tags[0]}` : ""}`);
  return (
    <div className="linkbox">
      <span className="muted" style={{ fontSize: 12 }}>Linked project BOM items</span>
      <div className="bubbles">
        {links.map((id) => {
          const b = findNode([bomUnit], id)?.node;
          return (
            <span key={id} className={`bubble${b ? "" : " gone"}`} title={b ? undefined : "No longer on the referenced BOM"}>
              {b ? label(b) : "(removed)"}
              <button type="button" className="btn-ghost" aria-label="Unlink" onClick={() => onChange(links.filter((x) => x !== id))}>✕</button>
            </span>
          );
        })}
        <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>Link…</button>
      </div>
      {open && <LinkModal bomUnit={bomUnit} cat={cat} value={links} label={label} onClose={() => setOpen(false)} onDone={(l) => (onChange(l), setOpen(false))} />}
    </div>
  );
}

function LinkModal({ bomUnit, cat, value, label, onClose, onDone }: { bomUnit: BomNode; cat: Catalog; value: string[]; label: (b: BomNode) => string; onClose: () => void; onDone: (l: string[]) => void }) {
  const [sel, setSel] = useState(() => new Set(value));
  const [q, setQ] = useState("");
  const nos = useMemo(() => itemNumbers([bomUnit]), [bomUnit]);
  const rows: { n: BomNode; depth: number }[] = [];
  walk(bomUnit.children, (n, ps) => rows.push({ n, depth: ps.length }));
  const ql = q.trim().toLowerCase();
  const shown = ql ? rows.filter(({ n }) => `${label(n)} ${nodeIdentity(n, cat.ctx).description}`.toLowerCase().includes(ql)) : rows;
  return (
    <Modal onClose={onClose} label="Link to project BOM items">
      <div className="mh"><h3>Link to project BOM items</h3><span className="muted" style={{ fontSize: 12.5 }}>Groups, sub-assemblies or parts of {bomUnit.tags[0] ? `+${bomUnit.tags[0]}` : bomUnit.name}; their device tags show as bubbles on the drawing.</span></div>
      <div className="mb" style={{ minHeight: 360 }}>
        <input type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="scroll" style={{ maxHeight: "55vh" }}>
          <table className="mini wide">
            <tbody>
              {shown.map(({ n, depth }) => (
                <tr key={n.id} className={sel.has(n.id) ? "sel" : undefined}>
                  <td><input type="checkbox" aria-label={label(n)} checked={sel.has(n.id)} onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(n.id); else x.delete(n.id); return x; })} /></td>
                  <td className="mono muted">{nos.get(n.id)}</td>
                  <td style={{ paddingLeft: 6 + depth * 14 }}>{n.kind === "group" ? <b>{label(n)}</b> : <span className="mono">{label(n)}</span>}</td>
                  <td className="muted clipc">{n.kind === "part" ? nodeIdentity(n, cat.ctx).description : `${n.children.length} lines`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => onDone([...sel])}>Link {sel.size}</button>
      </div>
    </Modal>
  );
}

/** Set the BOM links of one layout line. */
export function updateLinks(u: BomNode, id: string, links: string[]): BomNode {
  if (u.id === id) return { ...u, links };
  return { ...u, children: updateNode(u.children, id, (n) => ({ ...n, links })) };
}

/** Left / right text of a device (Assembly Descriptions), fitted into the box height. */
export type DescOf = (n: BomNode) => { left: string; right: string };
export function DescText({ x, y, h, text, anchor = "start", maxSize = 13, maxW }: { x: number; y: number; h: number; text: string; anchor?: "start" | "end"; maxSize?: number; maxW?: number }) {
  const size = Math.max(4.5, Math.min(maxSize, ((h - 4) / Math.max(1, text.split("\n").filter((l) => l.trim()).length)) * 0.82));
  // Long text is cut to the room it has (… at the end) instead of running under the device tags.
  const fit = (l: string) => {
    if (!maxW) return l;
    const n = Math.max(3, Math.floor(maxW / (size * 0.62)));
    return l.length > n ? `${l.slice(0, n - 1)}…` : l;
  };
  const lines = text.split("\n").filter((l) => l.trim()).map(fit);
  if (!lines.length) return null;
  const lh = size * 1.15;
  const y0 = y + h / 2 - (lines.length * lh) / 2 + size * 0.85;
  return (
    <text x={x} y={y0} textAnchor={anchor} className="lbl desc" style={{ fontSize: size }}>
      {lines.map((l, i) => <tspan key={i} x={x} dy={i ? lh : 0} className={i ? "sub" : undefined}>{l}</tspan>)}
    </text>
  );
}

// ───────── Mechanical Design settings (⚙️) ─────────

export interface MechSettings {
  /** Draw 2D models (uploaded views) where available; off = generic boxes everywhere. */
  models: boolean;
  /** Device-tag bubbles of the panel / cabinet drawings. */
  bubStroke: string;
  bubFill: string;
  bubText: string;
  bubWeight: "400" | "600" | "700";
  /** Text size factor (1 = automatic size). */
  bubScale: number;
  bubFont: "mono" | "ui";
  bubItalic: boolean;
}
export const MECH_SETTINGS_DEFAULT: MechSettings = { models: true, bubStroke: "#0f6e6e", bubFill: "#ffffff", bubText: "#0f6e6e", bubWeight: "600", bubScale: 1, bubFont: "mono", bubItalic: false };
const MS_KEY = "fpl.mech.settings";
let msVal: MechSettings = (() => {
  try {
    return { ...MECH_SETTINGS_DEFAULT, ...JSON.parse(localStorage.getItem(MS_KEY) ?? "{}") };
  } catch {
    return { ...MECH_SETTINGS_DEFAULT };
  }
})();
const msSubs = new Set<() => void>();
export function useMechSettings(): [MechSettings, (p: Partial<MechSettings>) => void] {
  const v = useSyncExternalStore((f) => (msSubs.add(f), () => msSubs.delete(f)), () => msVal);
  const set = useCallback((p: Partial<MechSettings>) => {
    msVal = { ...msVal, ...p };
    try {
      localStorage.setItem(MS_KEY, JSON.stringify(msVal));
    } catch {
      /* ignore */
    }
    msSubs.forEach((f) => f());
  }, []);
  return [v, set];
}
/** The view to draw for a part, honouring the ⚙️ setting and the part's "Draw these 2D views" switch. */
export function useViewGate() {
  const [s] = useMechSettings();
  return useCallback(<T,>(part: { mech?: { useViews?: boolean } } | undefined | null, v: T | undefined): T | undefined => (!s.models || part?.mech?.useViews === false ? undefined : v), [s.models]);
}

/** Pick which device tag (BOM line + tag) a placed unit stands for, among the lines of the referenced BOM with the same part number. */
export function TagPin({ ov, node, inst, pin, bomUnit, onChange }: { ov?: Overlay; node: BomNode; inst: number; pin?: { id: string; inst: number } | null; bomUnit: BomNode | null; onChange: (p: { id: string; inst: number } | null) => void }) {
  const nos = useMemo(() => (bomUnit ? itemNumbers([bomUnit]) : new Map<string, string>()), [bomUnit]);
  if (!ov?.hasRef || !bomUnit) return <p className="muted" style={{ margin: 0, fontSize: 12 }}>Set a BOM reference to choose the device tag of this unit.</p>;
  const ch = ov.choices(node.id);
  const auto = ov.tags(node.id, inst).join(" ") || "no tag";
  const val = pin ? `${pin.id}|${pin.inst}` : "";
  const used = ch.some((c) => (c.tags.length ? c.tags.map((_, i) => `${c.node.id}|${i}`) : [`${c.node.id}|0`]).includes(val));
  return (
    <label className="f tagpin">Device tag on the project BOM ({ch.length} declaration{ch.length === 1 ? "" : "s"} of this part number)
      <select value={used ? val : ""} onChange={(e) => {
        const [id, i] = e.target.value.split("|");
        onChange(id ? { id, inst: Number(i) || 0 } : null);
      }}>
        <option value="">Automatic ({auto})</option>
        {ch.map((c) =>
          (c.tags.length ? c.tags : [""]).map((t, i) => (
            <option key={`${c.node.id}|${i}`} value={`${c.node.id}|${i}`}>{`${nos.get(c.node.id) ?? ""}  ${t ? `-${t}` : "(no tag)"}${c.node.qty > 1 ? `  · line of ${c.node.qty}` : ""}`}</option>
          )),
        )}
      </select>
      {pin && !used && <span className="errtxt">The chosen line is no longer on the referenced BOM.</span>}
    </label>
  );
}

// ───────── Device IDs (BOM item no. + number, defined here, synced to the project BOM) ─────────

export interface DevCtx {
  /** Every device ID of the layouts that reference the project. */
  entries: DeviceEntry[];
  prefixOf: (bomId: string) => string;
  /** Role sign of the BOM line ("-", "+", "="). */
  signOf: (bomId: string) => string;
  itemNo: (bomId: string) => string;
  /** Part number (parts) or name (groups) of a BOM line. */
  pnOf: (bomId: string) => string;
  /** Edit the BOM line's prefix (open project BOM); null when the referenced project isn't open. */
  editPrefix: ((bomId: string) => void) | null;
}
type Placed = { id: string; inst?: number; dev?: DeviceId | null; devs?: DeviceId[] | null; labels?: PartLabel[] | null; pin?: { id: string; inst: number } | null; showText?: boolean };

/** Part-line balloons (circles) of a placed device: item no. or part number of each labelled linked item. */
export function PartBalloons({ box, labels, dc, size = 9 }: { box: { x: number; y: number; w: number; h: number }; labels?: PartLabel[] | null; dc?: DevCtx; size?: number }) {
  const [st] = useMechSettings();
  if (!labels?.length || !dc) return null;
  const fs = size * (st.bubScale || 1);
  const seen = new Map<string, number>();
  return (
    <g className="balloons" pointerEvents="none">
      {labels.map((l) => {
        const text = l.show === "pn" ? dc.pnOf(l.bomId) : dc.itemNo(l.bomId);
        if (!text) return null;
        const k = seen.get(`${l.pos}${l.out}`) ?? 0;
        seen.set(`${l.pos}${l.out}`, k + 1);
        const w = Math.max(fs * 1.9, text.length * fs * 0.62 + fs * 0.9);
        const r = fs * 0.95;
        const circle = w <= r * 2.2;
        const rr = circle ? Math.max(r, w / 2) : r;
        const c = labelAnchor(box, l.pos, l.out, circle ? rr : w / 2, k, rr);
        return (
          <g key={l.bomId}>
            {circle ? <circle cx={c.x} cy={c.y} r={rr} fill="#fff" stroke={st.bubStroke} strokeWidth={1} /> : <rect x={c.x - w / 2} y={c.y - r} width={w} height={2 * r} rx={r} fill="#fff" stroke={st.bubStroke} strokeWidth={1} />}
            <text x={c.x} y={c.y + fs * 0.35} textAnchor="middle" fill={st.bubText} fontWeight={st.bubWeight} fontFamily={st.bubFont === "mono" ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : "system-ui, sans-serif"} style={{ fontSize: fs }}>{text}</text>
          </g>
        );
      })}
    </g>
  );
}
const devPrefix = (dc: DevCtx, d: DeviceId) => d.prefix?.trim() || dc.prefixOf(d.bomId);
/** Device tags shown on a placed unit: its device IDs (one per linked item), else the referenced BOM's tags. */
export function placeTags(ov: Overlay | undefined, dc: DevCtx | undefined, n: BomNode, p: Placed): string[] {
  const ds = devsOf(p).filter((d) => d.num?.trim());
  if (ds.length && dc) return ds.map((d) => `${dc.signOf(d.bomId)}${deviceTag(devPrefix(dc, d), d.num)}`);
  // With the BOM text hidden, group titles are not shown as tags either (only real device tags).
  const t = tagsOf(ov, n, p.inst ?? 0, p.pin).filter((x) => p.showText !== false || /^[-+=]/.test(x));
  if (!dc) return t;
  // Tags already given to other placed devices (device IDs) are not repeated on an unnumbered one.
  const taken = new Set(dc.entries.map((e) => `${dc.signOf(e.bomId)}${e.tag}`.toUpperCase()));
  return t.filter((x) => !taken.has(x.toUpperCase()));
}

export function DevicePanel(props: { ov?: Overlay; dc?: DevCtx; node: BomNode; place: Placed; cat: Catalog; bomUnit?: BomNode | null; onChange: (d: DeviceId[]) => void; onLabels?: (l: PartLabel[]) => void; onShowText?: (v: boolean) => void }) {
  return <DevicePanelIn key={props.place.id} {...props} />;
}
function DevicePanelIn({ ov, dc, node, place, cat, bomUnit, onChange, onLabels, onShowText }: { ov?: Overlay; dc?: DevCtx; node: BomNode; place: Placed; cat: Catalog; bomUnit?: BomNode | null; onChange: (d: DeviceId[]) => void; onLabels?: (l: PartLabel[]) => void; onShowText?: (v: boolean) => void }) {
  const devs = devsOf(place);
  // Linked project BOM items first, then the other declarations of the same part number.
  const options = useMemo(() => {
    const out: { node: BomNode; linked: boolean }[] = [];
    const seen = new Set<string>();
    const push = (b: BomNode | undefined, linked: boolean) => {
      if (!b || seen.has(b.id)) return;
      seen.add(b.id);
      out.push({ node: b, linked });
    };
    if (bomUnit) (node.links ?? []).forEach((id) => push(findNode([bomUnit], id)?.node, true));
    ov?.choices(node.id).forEach((c) => push(c.node, false));
    devs.forEach((d) => bomUnit && push(findNode([bomUnit], d.bomId)?.node, true));
    return out;
  }, [bomUnit, node, ov, devs]);
  const [cur, setCur] = useState<string>(() => devs[0]?.bomId ?? options[0]?.node.id ?? "");
  if (!ov?.hasRef || !dc) return <p className="muted" style={{ margin: 0, fontSize: 12 }}>Set a BOM reference (toolbar) to define device IDs against BOM item numbers.</p>;
  const bomId = options.some((o) => o.node.id === cur) ? cur : options[0]?.node.id ?? "";
  const d: DeviceId = devs.find((x) => x.bomId === bomId) ?? { bomId, num: "" };
  const others = dc.entries.filter((e) => e.bomId === bomId && e.placeId !== place.id).map((e) => e.num);
  const sugg = nextNumbers(others, 3);
  const sign = bomId ? dc.signOf(bomId) : "-";
  const bomPrefix = bomId ? dc.prefixOf(bomId) : "";
  const prefix = d.prefix?.trim() || bomPrefix;
  const tag = d.num.trim() ? `${sign}${deviceTag(prefix, d.num)}` : "";
  const setD = (patch: Partial<DeviceId>) => {
    const nd = { ...d, ...patch, bomId };
    const keep = nd.num.trim() || nd.prefix?.trim();
    const rest = devs.filter((x) => x.bomId !== bomId);
    onChange(keep ? [...rest, { bomId, num: nd.num.trim(), ...(nd.prefix?.trim() ? { prefix: nd.prefix.trim() } : {}) }] : rest);
  };
  const label = (b: BomNode) => (b.kind === "part" ? nodeIdentity(b, cat.ctx).partNumber : `${b.line ? "Sub-assembly" : "Group"} ${b.alias || b.name || ""}`.trim());
  const ids = new Set(options.map((o) => o.node.id));
  const list = dc.entries.filter((e) => ids.has(e.bomId));
  const count = (t: string) => dc.entries.filter((e) => e.tag.toUpperCase() === t.toUpperCase()).length;
  const tagOf = (id: string) => {
    const x = devs.find((y) => y.bomId === id && y.num.trim());
    return x ? `${dc.signOf(id)}${deviceTag(devPrefix(dc, x), x.num)}` : "";
  };
  const nameOf = (id: string) => {
    const b = options.find((o) => o.node.id === id)?.node;
    return b ? label(b) : "";
  };
  return (
    <div className="devpanel">
      <div className="pane-head" style={{ padding: 0, border: 0 }}><h3>Device ID</h3><span className="muted" style={{ fontSize: 12 }}>{devs.filter((x) => x.num.trim()).length} defined</span></div>
      {onShowText && (
        <label className="chk-l" title="Off: the drawing shows no text from the bill of material for this device (description / group title, also as a tag); only device tags and part-line balloons">
          <input type="checkbox" checked={place.showText !== false} onChange={(e) => onShowText(e.target.checked)} /> Show BOM text on the drawing (description / group title)
        </label>
      )}
      {options.length > 1 && (
        <div className="devlinks" role="tablist" aria-label="Linked project BOM items">
          {options.map((o) => (
            <button key={o.node.id} type="button" role="tab" aria-selected={o.node.id === bomId} className={`devlink${o.node.id === bomId ? " on" : ""}${o.linked ? " linked" : ""}`} onClick={() => setCur(o.node.id)} title={o.linked ? "Linked to this layout line" : "Same part number elsewhere on the BOM"}>
              <span className="mono muted">{dc.itemNo(o.node.id) || "?"}</span> {label(o.node)}
              <b className="mono">{tagOf(o.node.id) || "—"}</b>
            </button>
          ))}
        </div>
      )}
      <label className="f">BOM item no.
        <select value={bomId} onChange={(e) => setCur(e.target.value)}>
          {!options.length && <option value="">— not on the referenced BOM —</option>}
          {options.map((o) => {
            const p = dc.prefixOf(o.node.id);
            return <option key={o.node.id} value={o.node.id}>{`${dc.itemNo(o.node.id) || "?"}  ·  ${label(o.node)}  ·  ${p ? `${dc.signOf(o.node.id)}${p}` : "(no prefix)"}  ·  qty ${o.node.qty}${o.linked ? "  · linked" : ""}`}</option>;
          })}
        </select>
      </label>
      <div className="frow tight" style={{ alignItems: "flex-end" }}>
        <label className="f" title="Prefix of this device. Empty = the prefix of the BOM line.">Prefix
          <input type="text" className="mono" aria-label="Device prefix" value={d.prefix ?? ""} placeholder={bomPrefix || "(none)"} disabled={!bomId} onChange={(e) => setD({ prefix: e.target.value })} style={{ width: 90 }} />
        </label>
        <button type="button" className="btn-ghost" disabled={!bomId || !dc.editPrefix} title={dc.editPrefix ? "Edit the prefix of the BOM line itself (open project BOM; every device of the line)" : "Open the referenced project in Parts & BOM (latest version) to edit its prefixes from here"} onClick={() => dc.editPrefix?.(bomId)}>BOM prefix…</button>
        <label className="f">Number
          <input type="text" className="mono" value={d.num} placeholder={sugg[0]} aria-label="Device number" disabled={!bomId} onChange={(e) => setD({ num: e.target.value.trim() })} style={{ width: 80 }} />
        </label>
        {(d.num || d.prefix) && <button type="button" className="btn-ghost" onClick={() => onChange(devs.filter((x) => x.bomId !== bomId))}>Clear</button>}
      </div>
      <div className="bubbles">
        {sugg.map((x) => <button key={x} type="button" className="bubble" disabled={!bomId} onClick={() => setD({ num: x })}>.{x}</button>)}
      </div>
      <div className={`devtag${tag && count(tag.slice(1)) > 1 ? " dup" : ""}`}>Device tag: <b className="mono">{tag || "—"}</b>{d.prefix?.trim() && <span className="muted"> (device prefix)</span>}{tag && count(tag.slice(1)) > 1 && <span className="errtxt"> duplicate in this project</span>}</div>
      {onLabels && (
        <div className="labelset">
          <div className="pane-head" style={{ padding: 0, border: 0 }}><h3>Part-line labels</h3><span className="muted" style={{ fontSize: 12 }}>balloon near the device</span></div>
          <table className="mini wide">
            <thead><tr><th aria-label="Label" /><th>Position</th><th>Place</th><th>Shows</th></tr></thead>
            <tbody>
              {(options.some((o) => o.linked) ? options.filter((o) => o.linked) : options).map((o) => {
                const lb = (place.labels ?? []).find((x) => x.bomId === o.node.id);
                const put = (patch: Partial<PartLabel> | null) => {
                  const rest = (place.labels ?? []).filter((x) => x.bomId !== o.node.id);
                  onLabels(patch === null ? rest : [...rest, { bomId: o.node.id, pos: "TL", out: false, show: "item", ...(lb ?? {}), ...patch }]);
                };
                // Row 1: the linked item; row 2: position, place and what the balloon shows.
                return [
                  <tr key={`${o.node.id}a`} className={`lblhead${lb ? " sel" : ""}`}>
                    <td rowSpan={2}><input type="checkbox" aria-label={`Label ${label(o.node)}`} checked={!!lb} onChange={(e) => put(e.target.checked ? {} : null)} /></td>
                    <td colSpan={3}><span className="mono muted">{dc.itemNo(o.node.id)}</span> {label(o.node)}</td>
                  </tr>,
                  <tr key={`${o.node.id}b`} className={`lblopts${lb ? " sel" : ""}`}>
                    <td>
                      <select aria-label="Label position" value={lb?.pos ?? "TL"} disabled={!lb} onChange={(e) => put({ pos: e.target.value as LabelPos })}>
                        {LABEL_POS.map(([v, l]) => <option key={v} value={v} title={l}>{v} · {l}</option>)}
                      </select>
                    </td>
                    <td>
                      <select aria-label="Inside or outside" value={lb?.out ? "out" : "in"} disabled={!lb} onChange={(e) => put({ out: e.target.value === "out" })}>
                        <option value="in">Inside</option><option value="out">Outside</option>
                      </select>
                    </td>
                    <td>
                      <select aria-label="Label shows" value={lb?.show ?? "item"} disabled={!lb} onChange={(e) => put({ show: e.target.value as PartLabel["show"] })}>
                        <option value="item">Item no.</option><option value="pn">Part number</option>
                      </select>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      <table className="mini wide devlist">
        <thead><tr><th>Part number</th><th>Item</th><th>Layout</th><th>Device tag</th><th>Qty</th></tr></thead>
        <tbody>
          {list.length ? list.slice().sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true })).map((e) => (
            <tr key={`${e.layout}|${e.placeId}|${e.bomId}`} className={e.placeId === place.id && e.bomId === bomId ? "sel" : undefined}>
              <td className="mono">{nameOf(e.bomId)}</td><td className="mono muted">{dc.itemNo(e.bomId)}</td><td>{e.layout}</td>
              <td className="mono">{dc.signOf(e.bomId)}{e.tag}</td>
              <td className={`num${count(e.tag) > 1 ? " errtxt" : ""}`}>{count(e.tag)}</td>
            </tr>
          )) : <tr><td colSpan={5} className="muted">No device IDs defined for these items yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
