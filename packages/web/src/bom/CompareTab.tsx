import { DEFAULT_DIFF_SPEC, diffBom, diffGrids, diffScope, diffSheet, fmtDateTime, pyStr, refreshSnaps, verLabel, evalNode, execCode, parseExpr, type BomDiff, type BomDoc, type DiffExportSpec, type DiffSheetSpec, type DiffStatus } from "@fpl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type Versioned } from "../api";
import { useLocal, useUi } from "../ui";
import { STATUS_LABEL, fmtN, type Catalog } from "./shared";
import { PROJ_KEY } from "./mechPlaced";
import { stableJson } from "../snapshots";
import { versionPointer } from "../VersionBar";
import { useMfrAliases } from "./aliases";
import { moveItem, useRowDrag } from "../dragRows";

type Pick = { id: string; major: number; minor: number } | "current" | null;
const key = (p: Pick) => (p === "current" ? "current" : p ? `${p.id}|${p.major}|${p.minor}` : "");
const parse = (s: string): Pick => {
  if (s === "current") return "current";
  const [id, a, b] = s.split("|");
  return id ? { id, major: Number(a), minor: Number(b) } : null;
};

/** Compare two BOM versions (e.g. 60 % vs 90 % vs IFC): purchasing totals by part and line-by-line changes. */
export function CompareTab({ cat, current }: { cat: Catalog; current: BomDoc }) {
  const ui = useUi();
  const [projects, setProjects] = useState<Versioned[]>([]);
  const [sel, setSel] = useLocal<{ a: string; b: string; show: string; hideSame: boolean }>("fpl.bom.compare", { a: "", b: "current", show: "rollup", hideSame: true });
  const [docs, setDocs] = useState<Record<string, BomDoc>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.bomProjects.list().then(setProjects).catch((e) => setErr(errMsg(e)));
  }, []);
  // The open project is named by its saved version and stage (+ "unsaved changes" when it differs from that version).
  const curLabel = useMemo(() => {
    const ptr = versionPointer(PROJ_KEY);
    let saved: string | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(PROJ_KEY) ?? "{}").savedHash ?? null;
    } catch {
      /* none */
    }
    const dirty = !cat.loaded ? false : stableJson({ ...current, units: refreshSnaps(current.units, cat.ctx) }) !== saved;
    const nm = current.project.name || projects.find((x) => x.id === ptr.id)?.name || "Open project";
    return ptr.loaded ? `${nm} v${verLabel(ptr.loaded)} (${current.stage})${dirty ? " + unsaved changes" : ""}` : `${nm} (${current.stage}, not saved yet)`;
  }, [current, cat.loaded, cat.ctx, projects]);
  const label = (s: string) => {
    const p = parse(s);
    if (p === "current") return curLabel;
    if (!p) return "—";
    const pr = projects.find((x) => x.id === p.id);
    const v = pr?.versions.find((x) => x.major === p.major && x.minor === p.minor);
    return `${pr?.name ?? "?"} v${verLabel(p)}${v?.meta?.stage ? ` (${String(v.meta.stage)})` : ""}`;
  };
  const [spec, setSpec] = useLocal<DiffExportSpec>("fpl.bom.compareSpec", DEFAULT_DIFF_SPEC);
  const [gear, setGear] = useState(false);
  const aliases = useMfrAliases();
  useEffect(() => {
    for (const s of [sel.a, sel.b]) {
      const p = parse(s);
      if (!p || p === "current" || docs[s]) continue;
      api.bomProjects.getVersion(p.id, p.major, p.minor).then((v) => setDocs((d) => ({ ...d, [s]: v.data as BomDoc }))).catch((e) => setErr(errMsg(e)));
    }
  }, [sel.a, sel.b, docs]);
  const docOf = (s: string): BomDoc | null => (s === "current" ? { ...current, units: refreshSnaps(current.units, cat.ctx) } : docs[s] ?? null);
  const A = docOf(sel.a);
  const B = docOf(sel.b);
  // Compared on the saved snapshots (manufacturer / part number / description as they were in each version).
  const diff: BomDiff | null = useMemo(() => (A && B ? diffBom(A.units, B.units) : null), [A, B]);

  const options = (
    <>
      <option value="">— pick a version —</option>
      <option value="current">Current (open, unsaved changes included) — {curLabel}</option>
      {projects.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.versions.map((v) => (
            <option key={key({ id: p.id, major: v.major, minor: v.minor })} value={key({ id: p.id, major: v.major, minor: v.minor })}>
              v{verLabel(v)}{v.meta?.stage ? ` · ${String(v.meta.stage)}` : ""} · {fmtDateTime(v.savedAt)}{v.notes ? ` · ${v.notes.slice(0, 40)}` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
  const visible = (s: DiffStatus) => !sel.hideSame || s !== "same";
  const exportX = async () => {
    if (!diff) return;
    try {
      const la = label(sel.a);
      const lb = label(sel.b);
      const labels = { a: la, b: lb };
      const ch = diffSheet(diff.rollup.filter((r) => r.status !== "same"), spec.changes, cat.ctx, labels, { aliases });
      const all = diffSheet(diff.rollup, spec.all, cat.ctx, labels, { aliases });
      const lines = diffGrids(diff, la, lb).find((g) => g.name === "Line changes")!;
      const sheets = [{ name: "Purchasing changes", grid: ch.grid }, lines, { name: "All parts", grid: all.grid }];
      const errs = [...ch.errors, ...all.errors];
      if (errs.length) ui.toast(`Exported with Python errors (cells left empty): ${errs.slice(0, 2).join(" · ")}`);
      const fname = `BOM compare ${la} vs ${lb}`.replace(/%/g, "pct").replace(/[^\w.\- ()+]+/g, "_");
      await api.bomFiles.xlsx(fname, sheets.map((g) => ({ ...g, title: `${g.name}: ${la} → ${lb}` })));
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };

  return (
    <section className="pane">
      <div className="toolbar sub">
        <label className="ctl">A (from)<select value={sel.a} onChange={(e) => setSel({ ...sel, a: e.target.value })} style={{ maxWidth: 360 }}>{options}</select></label>
        <button type="button" className="btn-ghost" aria-label="Swap" title="Swap A and B" onClick={() => setSel({ ...sel, a: sel.b, b: sel.a })}>⇄</button>
        <label className="ctl">B (to)<select value={sel.b} onChange={(e) => setSel({ ...sel, b: e.target.value })} style={{ maxWidth: 360 }}>{options}</select></label>
        <span className="grow" />
        <label className="chk-l"><input type="checkbox" checked={sel.hideSame} onChange={(e) => setSel({ ...sel, hideSame: e.target.checked })} /> Hide unchanged</label>
        <span className="gearwrap">
          <button type="button" className="btn-ghost gear" aria-label="Purchasing summary settings" aria-expanded={gear} title="Columns and sort of the exported sheets (Python)" onClick={() => setGear((g) => !g)}>⚙️</button>
          {gear && <DiffSpecPopover spec={spec} setSpec={setSpec} sample={diff?.rollup.find((r) => r.status !== "same") ?? diff?.rollup[0] ?? null} cat={cat} labels={{ a: label(sel.a), b: label(sel.b) }} aliases={aliases} onClose={() => setGear(false)} />}
        </span>
        <button type="button" disabled={!diff} onClick={exportX}>Export purchasing summary (.xlsx)</button>
      </div>
      {err && <p className="notes" style={{ padding: "6px 12px" }}>{err}</p>}
      {diff ? (
        <>
          <div className="toolbar sub">
            {(["added", "removed", "increased", "decreased", "changed"] as DiffStatus[]).map((s) => <span key={s} className={`chip st-${s}`}>{diff.summary[s]} {STATUS_LABEL[s].toLowerCase()}</span>)}
            <span className="muted" style={{ fontSize: 12.5 }}>{diff.summary.same} unchanged part numbers</span>
            <span className="grow" />
            <div className="seg" role="group" aria-label="View">
              <button type="button" aria-pressed={sel.show === "rollup"} onClick={() => setSel({ ...sel, show: "rollup" })}>By part (purchasing)</button>
              <button type="button" aria-pressed={sel.show === "lines"} onClick={() => setSel({ ...sel, show: "lines" })}>By line</button>
            </div>
          </div>
          <div className="scroll">
            {sel.show === "rollup" ? (
              <table className="net diff">
                <thead><tr><th>Status</th><th>Manufacturer</th><th>Part number</th><th>Description</th><th>A</th><th>B</th><th>Δ</th><th>Where</th></tr></thead>
                <tbody>
                  {diff.rollup.filter((r) => visible(r.status)).map((r) => (
                    <tr key={r.key} className={`st-${r.status}`}>
                      <td><span className={`chip st-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                      <td>{r.manufacturer}</td><td className="mono">{r.partNumber}</td><td className="desc" title={r.description}>{r.description}</td>
                      <td className="num">{fmtN(r.a)}</td><td className="num">{fmtN(r.b)}</td><td className="num"><b>{r.delta > 0 ? "+" : ""}{fmtN(r.delta)}</b></td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.notes.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="net diff">
                <thead><tr><th>Status</th><th>Unit</th><th>Item</th><th>Manufacturer</th><th>Part number</th><th>Description</th><th>Changes</th></tr></thead>
                <tbody>
                  {diff.lines.filter((l) => visible(l.status) && (l.a ?? l.b)!.kind === "part").map((l, i) => {
                    const r = (l.b ?? l.a)!;
                    return (
                      <tr key={i} className={`st-${l.status}`}>
                        <td><span className={`chip st-${l.status}`}>{STATUS_LABEL[l.status]}</span></td>
                        <td className="mono">{l.unit}</td><td className="mono">{l.itemNo}</td><td>{r.manufacturer}</td><td className="mono">{r.partNumber}</td>
                        <td className="desc" title={r.description}>{r.description}</td><td style={{ fontSize: 12 }}>{l.changes.join("; ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state"><h3>Pick two versions</h3><p>Save project BOM versions as the drawing set evolves (60 % → 90 % → IFC), then compare any two — or a saved version against the open one. The purchasing summary exports to Excel.</p></div>
      )}
    </section>
  );
}

const NAMES = "status, mfr, pn, desc, a, b, delta, delta_s, notes, label_a, label_b, vendor, price, ext_a, ext_b, stock, on_order, in_master, sub, cat, series, sku, config1-3, mfr_alias, General[…], Spec[…], PowerIn[…], PowerOut[…]";

/**
 * Settings of the purchasing summary export: per sheet ("Purchasing changes", "All parts"), the columns (header + Python
 * expression) and the Python sort key. Stays open until a click outside it.
 */
function DiffSpecPopover({ spec, setSpec, sample, cat, labels, aliases, onClose }: {
  spec: DiffExportSpec; setSpec: (s: DiffExportSpec) => void; sample: BomDiff["rollup"][number] | null; cat: Catalog;
  labels: { a: string; b: string }; aliases: Record<string, string>; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"changes" | "all">("changes");
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || box.current?.contains(t) || t.closest(".gearwrap") || t.closest(".modal-bg")) return;
      onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose]);
  const sh = spec[tab];
  const setSh = (f: Partial<DiffSheetSpec>) => setSpec({ ...spec, [tab]: { ...sh, ...f } });
  const drag = useRowDrag((a, b) => setSh({ cols: moveItem(sh.cols, a, b) }));
  const scope = useMemo(() => (sample ? diffScope(sample, cat.ctx, labels, { aliases }) : null), [sample, cat.ctx, labels, aliases]);
  const tryRun = (src: string): string => {
    if (!scope || !src.trim()) return "";
    try {
      const v = /\breturn\b|\n/.test(src.trim()) ? execCode(src, scope) : evalNode(parseExpr(src.trim()), scope);
      return `→ ${v == null ? "" : pyStr(v)}`;
    } catch (e) {
      return `⚠ ${(e as Error).message}`;
    }
  };
  return (
    <div className="gearpop diffpop" ref={box} role="dialog" aria-label="Purchasing summary settings">
      <div className="cfh"><b>Purchasing summary export</b><span className="grow" /><span className="muted" style={{ fontSize: 11.5 }}>Click outside to close · saved in this browser</span></div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>Sheet “Purchasing changes”</button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}>Sheet “All parts”</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>One column per row: header ({"{A}"} / {"{B}"} = the compared versions) and a Python expression per part number. {sample ? <>Results for <b className="mono">{sample.partNumber}</b>.</> : "Pick two versions to see results."}</p>
      <table className="mini wide diffcols">
        <thead><tr><th aria-label="Move" /><th>Header</th><th>Python</th><th>Result</th><th aria-label="Remove" /></tr></thead>
        <tbody>
          {sh.cols.map((c, i) => {
            const r = tryRun(c.expr);
            return (
              <tr key={i} {...drag.row(i)}>
                <td><span {...drag.handle(i)}>⋮⋮</span></td>
                <td><input type="text" aria-label={`Header ${i + 1}`} value={c.header} onChange={(e) => setSh({ cols: sh.cols.map((x, j) => (j === i ? { ...x, header: e.target.value } : x)) })} /></td>
                <td><input type="text" className="mono" aria-label={`Python ${i + 1}`} value={c.expr} placeholder="e.g. vendor" onChange={(e) => setSh({ cols: sh.cols.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)) })} /></td>
                <td className={r.startsWith("⚠") ? "errtxt" : "muted"} style={{ fontSize: 11.5, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r}>{r}</td>
                <td><button type="button" className="btn-ghost btn-danger" aria-label={`Remove column ${i + 1}`} onClick={() => setSh({ cols: sh.cols.filter((_x, j) => j !== i) })}>✕</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="toolbar" style={{ gap: 6 }}>
        <button type="button" onClick={() => setSh({ cols: [...sh.cols, { header: "NEW", expr: "" }] })}>+ Column</button>
        <button type="button" className="btn-ghost" onClick={() => setSh({ cols: [{ header: "VENDOR", expr: "vendor" }, ...sh.cols] })}>+ Vendor first</button>
        <button type="button" className="btn-ghost" onClick={() => setSh({ cols: [...sh.cols, { header: "UNIT PRICE", expr: 'f"{price:.2f}" if price is not None else ""' }, { header: "EXT. Δ", expr: 'f"{price * delta:.2f}" if price is not None else ""' }] })}>+ Price columns</button>
        <span className="grow" />
        <button type="button" className="btn-ghost" onClick={() => setSpec({ ...spec, [tab]: DEFAULT_DIFF_SPEC[tab] })}>Reset this sheet</button>
      </div>
      <div className="sortbox" style={{ gap: 4 }}>
        <label className="f">Sort key (Python; empty = as compared)
          <input type="text" className="mono" aria-label="Sort key" value={sh.sort} placeholder='e.g. (vendor, mfr, sub, pn)  or  -abs(delta)  or  desc' onChange={(e) => setSh({ sort: e.target.value })} />
        </label>
        <div className="frow tight" style={{ alignItems: "center" }}>
          <label className="chk-l"><input type="checkbox" checked={sh.descending} onChange={(e) => setSh({ descending: e.target.checked })} /> Descending</label>
          <span className={tryRun(sh.sort).startsWith("⚠") ? "errtxt" : "muted"} style={{ fontSize: 11.5 }}>{tryRun(sh.sort)}</span>
        </div>
        <div className="frow tight" style={{ flexWrap: "wrap" }}>
          {[["Vendor › mfr › sub › PN", "(vendor, mfr, sub, pn)"], ["Description", "desc"], ["Largest change", "-abs(delta)"], ["Ext. price B", "-(ext_b or 0)"], ["Status", "(status, pn)"]].map(([l, k]) => (
            <button key={l} type="button" className="btn-ghost" onClick={() => setSh({ sort: k, descending: false })}>{l}</button>
          ))}
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>Names: {NAMES}.</p>
    </div>
  );
}
