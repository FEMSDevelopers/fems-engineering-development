import { VIEW_AXES, VIEW_NAMES, nameResembles, normMfr, partDims, type Part, type PartView, type ViewName } from "@fpl/core";
import { useEffect, useState } from "react";
import { api, errMsg, type CadInfo } from "../api";
import { Modal, useLocal, useUi } from "../ui";
import { invalidateViews, viewSrc } from "./viewCache";
import { fmtN } from "./shared";

export { viewSrc };
type Rot = "z+" | "z-" | "x+" | "x-" | "y+" | "y-";
const ROTS: { rot: Rot; icon: string; label: string; title: string }[] = [
  { rot: "z+", icon: "⟲", label: "Z +90°", title: "Rotate left (counter-clockwise) about the viewing axis, as seen from the front view" },
  { rot: "z-", icon: "⟳", label: "Z −90°", title: "Rotate right (clockwise) about the viewing axis, as seen from the front view" },
  { rot: "x+", icon: "⤓", label: "X +90°", title: "Tilt about the horizontal (X) axis: the top comes towards you and becomes the front" },
  { rot: "x-", icon: "⤒", label: "X −90°", title: "Tilt about the horizontal (X) axis: the bottom comes towards you and becomes the front" },
  { rot: "y+", icon: "↶", label: "Y +90°", title: "Turn left about the vertical (Y) axis (counter-clockwise seen from above): the left side becomes the front" },
  { rot: "y-", icon: "↷", label: "Y −90°", title: "Turn right about the vertical (Y) axis (clockwise seen from above): the right side becomes the front" },
];

/** The current view that becomes the front view after a rotation (z±: the front stays the front, turned 90°). */
const NEXT_FRONT: Record<Rot, { view: ViewName; note: string }> = {
  "z+": { view: "front", note: "stays the front, turned 90° left" },
  "z-": { view: "front", note: "stays the front, turned 90° right" },
  "x+": { view: "top", note: "becomes the front" },
  "x-": { view: "bottom", note: "becomes the front" },
  "y+": { view: "left", note: "becomes the front" },
  "y-": { view: "right", note: "becomes the front" },
};

/** With the 180° step: the view that becomes the front view (z: the front, upside down; x / y: the back). */
const NEXT_FRONT_180: Record<Rot, { view: ViewName; note: string }> = {
  "z+": { view: "front", note: "stays the front, turned 180°" },
  "z-": { view: "front", note: "stays the front, turned 180°" },
  "x+": { view: "back", note: "becomes the front (upside down)" },
  "x-": { view: "back", note: "becomes the front (upside down)" },
  "y+": { view: "back", note: "becomes the front" },
  "y-": { view: "back", note: "becomes the front" },
};

/**
 * Orientation of the STEP models of a product series (manufacturer · subcategory · series), shared in the database:
 * a STEP imported for any part of the series uses it.
 */
interface SeriesOrient { mfr: string; subcategoryId: string | null; series: string; up: string; front: string; updatedAt: string }
const ORIENT_SCOPE = "bom.step-orient";
const ORIENT_NAME = "series";
type ScopePart = { manufacturer?: string; subcategoryId?: string | null; series?: string };
const sameSeries = (a: ScopePart, b: ScopePart) =>
  normMfr(a.manufacturer ?? "") === normMfr(b.manufacturer ?? "") && (a.subcategoryId ?? null) === (b.subcategoryId ?? null) &&
  (a.series ?? "").trim().toLowerCase() === (b.series ?? "").trim().toLowerCase();
const ruleScope = (r: SeriesOrient): ScopePart => ({ manufacturer: r.mfr, subcategoryId: r.subcategoryId, series: r.series });
async function loadSeriesOrients(): Promise<{ id: string | null; rules: SeriesOrient[] }> {
  const l = await api.presets.list<{ rules: SeriesOrient[] }>(ORIENT_SCOPE);
  const p = l.find((x) => x.name === ORIENT_NAME);
  return { id: p?.id ?? null, rules: p?.data.rules ?? [] };
}
/** Same as the server (cad.ts rotateOrientation): device X right, Y up, Z out of the front. */
const AV: Record<string, [number, number, number]> = { "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0], "+Z": [0, 0, 1], "-Z": [0, 0, -1] };
const toAxis = (v: number[]) => {
  const k = v.findIndex((c) => Math.abs(c) > 0.5);
  return `${v[k] < 0 ? "-" : "+"}${"XYZ"[k]}`;
};
function rotateLocal(up: string, front: string, rot: Rot): { up: string; front: string } {
  const Y = AV[up], Z = AV[front];
  const X = [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]];
  const neg = (v: number[]) => v.map((c) => -c);
  const [nu, nf] =
    rot === "z+" ? [X, Z] : rot === "z-" ? [neg(X), Z] : rot === "x+" ? [neg(Z), Y] : rot === "x-" ? [Z, neg(Y)] : rot === "y+" ? [Y, neg(X)] : [Y, X];
  return { up: toAxis(nu), front: toAxis(nf) };
}

/** Render page 1 of a PDF to a PNG data URL (pdf.js, loaded on demand). */
export async function pdfToPng(file: File, maxPx = 2400): Promise<{ url: string; wMm: number; hMm: number }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(6, maxPx / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  // PDF points → mm
  return { url: canvas.toDataURL("image/png"), wMm: (base.width / 72) * 25.4, hMm: (base.height / 72) * 25.4 };
}
const readUrl = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});

/** Upload one view from an SVG, DXF, PDF (page 1) or image file. */
export async function importViewFile(partId: string, view: ViewName, f: File, size: { w: number | null; h: number | null }) {
  const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (ext === "pdf") {
    const r = await pdfToPng(f);
    await api.views.put(partId, view, { kind: "image", content: r.url, wMm: size.w ?? r.wMm, hMm: size.h ?? r.hMm, source: `${f.name} (page 1)` });
  } else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
    await api.views.put(partId, view, { kind: "image", content: await readUrl(f), wMm: size.w, hMm: size.h, source: f.name });
  } else await api.views.import(partId, f, { view });
}

/** Dimensions (x/y/z + adders) and the six 2D views of a saved part. */
export function PartViews({ part, parts = [], subName, onDims }: {
  part: Pick<Part, "id" | "mech"> & { partNumber?: string; sku?: string } & ScopePart;
  /** Master parts (the other parts of the same product series). */
  parts?: Part[];
  subName?: string;
  onDims: (d: { x: number; y: number; z: number }) => void }) {
  const ui = useUi();
  const [views, setViews] = useState<PartView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Orientation of the STEP model (model axis up / out of the front): the imported model's, else the one the next import uses.
  const [orient, setOrient] = useState<{ up: string; front: string }>({ up: "+Z", front: "-Y" });
  const [cad, setCad] = useState<CadInfo | null>(null);
  // Product-series orientation: used by a STEP import of any part of the series.
  const [seriesRule, setSeriesRule] = useState<SeriesOrient | null>(null);
  const [seriesDlg, setSeriesDlg] = useState(false);
  const [hoverRot, setHoverRot] = useState<Rot | null>(null);
  // Rotation step: 90° or 180° per click (remembered in this browser).
  const [step, setStep] = useLocal<90 | 180>("fpl.bom.rotStep", 90);
  const nextFront = hoverRot ? (step === 180 ? NEXT_FRONT_180[hoverRot] : NEXT_FRONT[hoverRot]) : null;
  const seriesKey = `${normMfr(part.manufacturer ?? "")}|${part.subcategoryId ?? ""}|${(part.series ?? "").trim().toLowerCase()}`;
  // ⚠️ when neither the uploaded file nor the STEP inside it is named like the part number or SKU.
  const codes = [part.partNumber, part.sku];
  const hasCode = codes.some((c) => (c ?? "").replace(/[^A-Za-z0-9]/g, "").length >= 3);
  const nameOff = (...names: string[]) => hasCode && !names.some((n) => n && nameResembles(n, codes));
  const offWarn = `doesn't resemble the part number${part.sku ? " or SKU" : ""} (${[part.partNumber, part.sku].filter(Boolean).join(" / ")}) — check it is the right model`;
  const { up, front } = orient;
  const [setDims, setSetDims] = useState(true);
  const [keep, setKeep] = useState(true);
  const [big, setBig] = useState<PartView | null>(null);
  const load = () => {
    Promise.all([api.views.cad(part.id), loadSeriesOrients().catch(() => ({ id: null, rules: [] as SeriesOrient[] }))]).then(([c, so]) => {
      setCad(c);
      const rule = part.manufacturer ? so.rules.find((r) => sameSeries(ruleScope(r), part)) ?? null : null;
      setSeriesRule(rule);
      if (c) setOrient({ up: c.up, front: c.front });
      else if (rule) setOrient({ up: rule.up, front: rule.front });
    }).catch(() => setCad(null));
    return api.views.list([part.id]).then((v) => (setViews(v), invalidateViews(part.id))).catch((e) => ui.toast(errMsg(e)));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part.id, seriesKey]);
  const dims = partDims(part as Part);
  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    try {
      await f();
      await load();
    } catch (e) {
      ui.toast(`Import failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const stepImport = (file: File) =>
    run("step", async () => {
      const r = await api.views.import(part.id, file, { up, front, dims: setDims, keep });
      if (r.dims && setDims) onDims(r.dims);
      ui.toast(`${nameOff(file.name, ...r.notes) ? `⚠️ ${file.name} ${offWarn}. ` : ""}STEP imported: ${r.notes.join(" · ")}`);
    });
  /** With a STEP model: re-draw every view in the new orientation; without: set the orientation the next import uses. */
  const rotate = (rot: Rot | "reset") => {
    const times = step === 180 ? 2 : 1;
    if (!cad) {
      setOrient(rot === "reset" ? { up: "+Z", front: "-Y" } : times === 2 ? rotateLocal(rotateLocal(up, front, rot).up, rotateLocal(up, front, rot).front, rot) : rotateLocal(up, front, rot));
      return;
    }
    return run("rotate", async () => {
      const r = await api.views.rotate(part.id, rot === "reset" ? { reset: true, dims: setDims } : { rot, times, dims: setDims });
      setOrient({ up: r.up, front: r.front });
      if (setDims) onDims(r.dims);
    });
  };
  return (
    <div className="pviews">
      <div className="frow tight step">
        <label className="btn btn-primary" style={{ alignSelf: "flex-end" }}>
          {busy === "step" ? "Reading STEP…" : "Import STEP (.stp / .zip)…"}
          <input type="file" accept=".stp,.step,.zip" title="A .stp / .step file, or a .zip holding the .stp and its .txt" disabled={!!busy} onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) stepImport(f);
          }} />
        </label>
        <div className="f rotbox">
          <span className="rotlbl">Rotate <span className="muted">(as seen from the front view)</span>
            <span className="seg mini" role="group" aria-label="Rotation step" title="Degrees turned by each rotate button">
              {([90, 180] as const).map((d) => <button key={d} type="button" aria-pressed={step === d} onClick={() => setStep(d)}>{d}°</button>)}
            </span>
          </span>
          <div className="rotbtns" role="group" aria-label="Rotate the model">
            {ROTS.map((r) => (
              <button key={r.rot} type="button" disabled={!!busy} title={`${r.title}${cad ? " — all six views are re-drawn" : " — applied when the STEP is imported"}`} aria-label={`Rotate ${step === 180 ? r.label.replace("90°", "180°") : r.label}`} onClick={() => rotate(r.rot)}
                onMouseEnter={() => setHoverRot(r.rot)} onMouseLeave={() => setHoverRot(null)} onFocus={() => setHoverRot(r.rot)} onBlur={() => setHoverRot(null)}>
                <span className="ri">{r.icon}</span> {step === 180 ? r.label.replace("90°", "180°") : r.label}
              </button>
            ))}
            <button type="button" className="btn-ghost" disabled={!!busy || (up === "+Z" && front === "-Y")} title="Back to the STEP file's own axes (+Z up, −Y front)" onClick={() => rotate("reset")}>Reset</button>
          </div>
          <span className="muted rotstate" title={cad ? `${cad.fileName}${cad.stored ? "" : " (from the part's documents)"}` : "No STEP imported yet"}>
            {busy === "rotate" ? "Re-drawing the views…" : `Model ${up} up · ${front} front${cad ? "" : seriesRule && seriesRule.up === up && seriesRule.front === front ? " (series orientation, for the next import)" : " (for the next import)"}`}
          </span>
          <span className="seriesrow">
            <button type="button" className="btn-ghost" disabled={!!busy || !part.manufacturer} onClick={() => setSeriesDlg(true)}
              title={part.manufacturer ? "Use this orientation for every part of the same manufacturer · subcategory · product series: STEP files imported for them are drawn this way, and the ones already imported can be re-drawn now" : "Set the manufacturer first"}>
              Apply to series…
            </button>
            {seriesRule && <span className="muted" title={`Saved ${new Date(seriesRule.updatedAt).toLocaleString()}`}>Series: {seriesRule.up} up · {seriesRule.front} front</span>}
          </span>
        </div>
        {cad && (
          <div className="f cadsrc">
            <span className="rotlbl">STEP model</span>
            <span className="cadname" title={`Uploaded: ${cad.sourceName}${cad.sourceName !== cad.fileName ? `\nSTEP: ${cad.fileName}` : ""}${cad.txtName ? `\nText: ${cad.txtName}` : ""}`}>
              {nameOff(cad.sourceName, cad.fileName) && <span className="namewarn" role="img" aria-label="Name does not match the part" title={`${cad.sourceName} ${offWarn}`}>⚠️</span>}
              <b>{cad.sourceName}</b>{cad.sourceName !== cad.fileName && <span className="muted"> › {cad.fileName}</span>}
            </span>
            {cad.txtName && (
              <details className="cadtxt">
                <summary>📄 {cad.txtName}</summary>
                <pre>{cad.txt ?? "(larger than 1 MB — not shown)"}</pre>
              </details>
            )}
          </div>
        )}
        <label className="chk-l" style={{ alignSelf: "flex-end" }}><input type="checkbox" checked={setDims} onChange={(e) => setSetDims(e.target.checked)} /> Set x/y/z from the model</label>
        <label className="chk-l" style={{ alignSelf: "flex-end" }}><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep the STEP in documents</label>
        <span className="muted" style={{ alignSelf: "flex-end", fontSize: 11.5 }} title="AutoCAD (.dwg, .dxf, .dwt, .dws, .dwf…) and PDF / SVG → Drawing / CAD, suffix 2D · .stp / .step → Drawing / CAD, suffix STEP · images → Image. Files already stored (same name and size) are skipped.">
          ZIP: its CAD, STEP, PDF / SVG and image files are always stored in documents ⓘ</span>
      </div>
      <div className="vgrid">
        {VIEW_NAMES.map((v) => {
          const pv = views.find((x) => x.view === v);
          const [a, b] = VIEW_AXES[v];
          const size = { w: dims[a], h: dims[b] };
          return (
            <div key={v} className={`vcard${nextFront?.view === v ? ` nextfront${hoverRot?.[0] === "z" ? " turn" : ""}` : ""}`}>
              {nextFront?.view === v && <span className="nfbadge">{hoverRot?.[0] === "z" ? (step === 180 ? "↻ " : hoverRot === "z+" ? "⟲ " : "⟳ ") : "→ "}Front · {nextFront.note}</span>}
              <div className="vhead"><b>{v}</b><span className="muted">{a}×{b} {size.w != null && size.h != null ? `${fmtN(size.w, 0)}×${fmtN(size.h, 0)} mm` : ""}</span></div>
              <button type="button" className="vthumb" onClick={() => pv && setBig(pv)} title={pv ? `${pv.source}\nClick to enlarge` : "No view yet"}>
                {pv ? <img src={viewSrc(pv)} alt={`${v} view`} /> : <span className="muted">—</span>}
              </button>
              <div className="vtools">
                <label className="btn btn-ghost">
                  {busy === v ? "…" : pv ? "Replace" : "Upload"}
                  <input type="file" accept=".svg,.dxf,.pdf,.png,.jpg,.jpeg,.webp" disabled={!!busy} onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) run(v, () => importViewFile(part.id, v, f, size));
                  }} />
                </label>
                {pv && <button type="button" className="btn-ghost btn-danger" aria-label={`Delete ${v} view`} onClick={() => run(v, () => api.views.remove(part.id, v) as Promise<void>)}>✕</button>}
              </div>
              {pv && <span className="vsrc muted" title={pv.source}>{pv.source}</span>}
            </div>
          );
        })}
      </div>
      {seriesDlg && (
        <SeriesOrientModal part={part} parts={parts} subName={subName} orient={orient} dims={setDims} current={seriesRule}
          onDone={(r) => {
            setSeriesRule(r);
            setSeriesDlg(false);
          }}
          onClose={() => setSeriesDlg(false)} />
      )}
      {big && (
        <div className="modal-bg" onMouseDown={() => setBig(null)}>
          <div className="modal vbig" role="dialog" aria-label={`${big.view} view`}>
            <div className="mh"><h3>{big.view} view</h3><span className="muted">{big.source}{big.wMm ? ` · ${fmtN(big.wMm, 1)} × ${fmtN(big.hMm, 1)} mm` : ""}</span></div>
            <div className="mb"><img src={viewSrc(big)} alt="" /></div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Save the orientation for the product series, and optionally re-draw the series' parts that already have a STEP model. */
function SeriesOrientModal({ part, parts, subName, orient, dims, current, onDone, onClose }: {
  part: Pick<Part, "id"> & ScopePart; parts: Part[]; subName?: string; orient: { up: string; front: string }; dims: boolean;
  current: SeriesOrient | null; onDone: (r: SeriesOrient | null) => void; onClose: () => void;
}) {
  const ui = useUi();
  const others = parts.filter((p) => p.id !== part.id && sameSeries(p, part));
  const [withCad, setWithCad] = useState<{ p: Part; cad: CadInfo }[] | null>(null);
  const [redraw, setRedraw] = useState(true);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all(others.map((p) => api.views.cad(p.id).then((c) => (c ? { p, cad: c } : null)).catch(() => null)))
      .then((l) => live && setWithCad(l.filter((x): x is { p: Part; cad: CadInfo } => !!x)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const change = (withCad ?? []).filter((x) => x.cad.up !== orient.up || x.cad.front !== orient.front);
  const scope = [part.manufacturer, subName || (part.subcategoryId ? "(subcategory)" : "no subcategory"), part.series || "no product series"].join(" · ");
  const save = async (rule: SeriesOrient | null) => {
    const so = await loadSeriesOrients();
    const rules = so.rules.filter((r) => !sameSeries(ruleScope(r), part));
    if (rule) rules.push(rule);
    if (rules.length || so.id) await api.presets.save(ORIENT_SCOPE, ORIENT_NAME, { rules });
  };
  const apply = async () => {
    const rule: SeriesOrient = { mfr: part.manufacturer ?? "", subcategoryId: part.subcategoryId ?? null, series: (part.series ?? "").trim(), up: orient.up, front: orient.front, updatedAt: new Date().toISOString() };
    try {
      setBusy("Saving…");
      await save(rule);
      let ok = 0;
      const failed: string[] = [];
      if (redraw)
        for (const [i, x] of change.entries()) {
          setBusy(`Re-drawing ${i + 1} / ${change.length}: ${x.p.partNumber}`);
          try {
            await api.views.rotate(x.p.id, { orient, dims });
            invalidateViews(x.p.id);
            ok++;
          } catch (e) {
            failed.push(`${x.p.partNumber} (${errMsg(e)})`);
          }
        }
      ui.toast(`Series orientation saved (${orient.up} up · ${orient.front} front)${redraw && change.length ? ` · ${ok} part${ok === 1 ? "" : "s"} re-drawn` : ""}${failed.length ? ` · failed: ${failed.join(", ")}` : ""}`);
      onDone(rule);
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <Modal onClose={busy ? () => undefined : onClose} label="Apply the orientation to the product series">
      <div className="mh"><h3>Apply the orientation to the product series</h3></div>
      <div className="mb">
        <p style={{ margin: 0 }}><b>{scope}</b> — <span className="mono">{orient.up} up · {orient.front} front</span></p>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Every part of this manufacturer · subcategory · product series will use this orientation when a STEP file (or .zip) is imported for it.
          {current ? ` Replaces the saved series orientation (${current.up} up · ${current.front} front).` : ""}
        </p>
        <p style={{ margin: 0, fontSize: 13 }}>
          {others.length} other part{others.length === 1 ? "" : "s"} in this series
          {withCad == null ? " · checking STEP models…" : ` · ${withCad.length} with a STEP model, ${change.length} drawn in another orientation`}
        </p>
        {withCad != null && change.length > 0 && (
          <>
            <label className="chk-l"><input type="checkbox" checked={redraw} onChange={(e) => setRedraw(e.target.checked)} /> Re-draw those {change.length} part{change.length === 1 ? "" : "s"} now{dims ? " (and update their x/y/z)" : ""}</label>
            <ul className="serieslist">{change.map((x) => <li key={x.p.id}><span className="mono">{x.p.partNumber}</span> <span className="muted">{x.cad.up} up · {x.cad.front} front → {orient.up} up · {orient.front} front</span></li>)}</ul>
          </>
        )}
        {busy && <p className="muted" style={{ margin: 0 }}>{busy}</p>}
      </div>
      <div className="mf">
        {current && <button type="button" className="btn-ghost btn-danger" disabled={!!busy} onClick={async () => {
          try {
            await save(null);
            ui.toast("Series orientation removed");
            onDone(null);
          } catch (e) {
            ui.toast(errMsg(e));
          }
        }}>Remove series orientation</button>}
        <span className="grow" />
        <button type="button" disabled={!!busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!!busy || withCad == null} onClick={apply}>Apply to series</button>
      </div>
    </Modal>
  );
}
