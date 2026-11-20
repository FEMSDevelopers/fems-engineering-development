import {
  bumpMajor, bumpMinor, chainOf, latest, parseIp, pathText, portAbbr, protocolLabel, sameVer, serviceColor, stamp, verLabel,
  type Connection, type Device, type DeviceCategory, type Hierarchy, type ProtocolDef, type Ver, type Vlan,
} from "@fpl/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, type Versioned } from "../api";
import { LibraryBar } from "../editor/LibraryBar";
import { ColorPick, Popover, Seg, useLocal, useUi } from "../ui";
import { dashArray, defaultPortOf, headSize, MarkerDefs, markerId, strokeWidth, LinePreview } from "./draw";
import { hopNamer } from "./PathEditor";
import { HOLD_NUM_MS, NumColorEditor, numberedIds, numStyle, useHold, type NumColor, type NumColors } from "./numbering";
import { DEFAULT_SUMMARY_COLS, SummaryPanel, type EndInfo, type SummaryRow } from "./SummaryPanel";

type Pos = { x: number; y: number };
interface View {
  x: number;
  y: number;
  k: number;
}
type BubbleField = "type" | "category" | "service" | "serial" | "model";
interface DiagramOpts {
  snap: boolean;
  labels: boolean;
  hideUnconnected: boolean;
  nodeScale: number;
  /** What sets a device bubble's colour (unless overridden per device). */
  colorBy: "service" | "category" | "none";
  /** Second line of each device bubble. */
  fields: BubbleField[];
  hiddenServices: string[];
  hiddenCategories: string[];
  /** Port tags (P1, ETH1 …) where each line starts and ends. */
  portTags: boolean;
  /** VLAN / IP at each connection end: the connection's own values when it defines them, else the device's. */
  netVlan: boolean;
  netIp: boolean;
  /** Free-text notes typed directly at connection ends. */
  endNotes: boolean;
  /** @deprecated replaced by netVlan / netIp (kept so older saved layouts load). */
  netLabels?: boolean;
}
/** Per-device customisation set by click-and-hold on a bubble. */
interface NodeOverride {
  color?: string;
  note?: string;
  noteColor?: string;
  /** Free text around the bubble (max 3 lines each), shown only when set. */
  textTop?: string;
  textBottom?: string;
  textLeft?: string;
  textRight?: string;
  sideColor?: string;
}
type EndNotes = Record<string, { client?: string; server?: string }>;
/** Summary panel: connection order (row numbers), visible columns, numbers on the lines. Saved with the diagram version. */
interface SummaryState {
  order: string[];
  cols: string[];
  numbers: boolean;
  open: boolean;
  /** Custom colours of row-number squares (click-and-hold a square to edit). */
  numColors?: NumColors;
}
interface DiagramData {
  positions: Record<string, Pos>;
  view: View;
  opts: DiagramOpts;
  overrides?: Record<string, NodeOverride>;
  endNotes?: EndNotes;
  summary?: SummaryState;
}
interface Draft extends DiagramData {
  overrides: Record<string, NodeOverride>;
  endNotes: EndNotes;
  summary: SummaryState;
  lib: { diagramId: string | null; loaded: Ver | null; pending: Ver; savedHash: string | null };
}
const V1: Ver = { major: 1, minor: 1 };
const DEFAULT_DRAFT: Draft = {
  positions: {},
  view: { x: 0, y: 0, k: 1 },
  opts: {
    snap: true, labels: true, hideUnconnected: false, nodeScale: 1,
    colorBy: "service", fields: ["type", "category"], hiddenServices: [], hiddenCategories: [], portTags: true,
    netVlan: true, netIp: true, endNotes: false,
  },
  overrides: {},
  endNotes: {},
  summary: { order: [], cols: DEFAULT_SUMMARY_COLS, numbers: true, open: true },
  lib: { diagramId: null, loaded: null, pending: V1, savedHash: null },
};
const NODE_W = 176;
const NODE_H = 58;
const GRID = 10;
const hasOverride = (o: NodeOverride) => Object.values(o).some(Boolean);
const hashOf = (d: Pick<DiagramData, "positions" | "opts" | "overrides" | "endNotes" | "summary">) =>
  JSON.stringify([
    d.summary ? [d.summary.order, d.summary.cols, d.summary.numbers, Object.entries(d.summary.numColors ?? {}).filter(([, c]) => c.bg || c.fg).sort()] : null,
    Object.entries(d.positions).sort(),
    d.opts,
    Object.entries(d.overrides ?? {}).filter(([, o]) => hasOverride(o)).sort(),
    Object.entries(d.endNotes ?? {}).filter(([, n]) => n.client || n.server).sort(),
  ]);
/** Older layouts had one VLAN / IP switch. */
const migrateOpts = (o: Partial<DiagramOpts> | undefined): DiagramOpts => {
  const m = { ...DEFAULT_DRAFT.opts, ...(o ?? {}) };
  if (o && o.netLabels !== undefined && o.netVlan === undefined) m.netVlan = m.netIp = o.netLabels;
  delete m.netLabels;
  return m;
};
/** Approximate glyph widths (px per character at 1×) used to wrap SVG text. */
const CH = { name: 7.3, sub: 6.3, note: 6.1, pill: 5.9, side: 6.0, net: 6.0 };
const MAX_LINES = 3;
/** Keep at most 3 typed lines. */
const clip3 = (v: string) => v.split("\n").slice(0, MAX_LINES).join("\n");
/** Word-wrap to `maxChars` per line (long words are broken), at most `maxLines` lines (last one gets "…"). */
function wrap(text: string | undefined, maxChars: number, maxLines = 99): string[] {
  const out: string[] = [];
  const n = Math.max(4, Math.floor(maxChars));
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while (w.length > n) {
        if (line) (out.push(line), (line = ""));
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      if (!line) line = w;
      else if ((line + " " + w).length <= n) line += " " + w;
      else (out.push(line), (line = w));
    }
    if (line || !para.trim()) out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  if (out.length > maxLines) {
    const cut = out.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].slice(0, Math.max(1, n - 1)) + "…";
    return cut;
  }
  return out;
}
const NOTE_COLOR = "#d99a1e";
const HOLD_MS = 500;
const FIELD_LABEL: Record<BubbleField, string> = { type: "Type", model: "Model", category: "Category", service: "Service", serial: "Serial number" };
const FIELD_ORDER: BubbleField[] = ["type", "model", "category", "service", "serial"];

/** Default layout: one column per VLAN (by VLAN ID), devices sorted by IP; unassigned devices last. */
function autoLayout(devices: Device[], vlans: Vlan[]): Record<string, Pos> {
  const cols = vlans.slice().sort((a, b) => (+a.vlan || 0) - (+b.vlan || 0)).map((v) => v.id);
  const out: Record<string, Pos> = {};
  const groups = new Map<string, Device[]>();
  for (const d of devices) {
    const k = d.vlanId && cols.includes(d.vlanId) ? d.vlanId : "_none";
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const order = [...cols.filter((c) => groups.has(c)), ...(groups.has("_none") ? ["_none"] : [])];
  order.forEach((k, ci) => {
    groups
      .get(k)!
      .sort((a, b) => (parseIp(a.ip) ?? 2 ** 33) - (parseIp(b.ip) ?? 2 ** 33) || a.name.localeCompare(b.name))
      .forEach((d, ri) => (out[d.id] = { x: 40 + ci * (NODE_W + 190), y: 60 + ri * (NODE_H + 96) }));
  });
  return out;
}

/** Point where the segment from the box centre toward (tx,ty) leaves the box. */
function exitPoint(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number, gap: number): Pos {
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap };
}

export function Diagram({
  devices, vlans, connections, protocols, visible, active, h, cats, onNetChanged,
}: {
  /** Services / firewalls for colours and grouping (devices and VLANs come separately: active ones only). */
  h: Hierarchy;
  cats: DeviceCategory[];
  /** Called after a service or category colour is changed here. */
  onNetChanged: () => void;
  devices: Device[];
  vlans: Vlan[];
  connections: Connection[];
  protocols: ProtocolDef[];
  /** Protocol ids passing the filter bubbles (null = all). */
  visible: Set<string> | null;
  active: boolean;
}) {
  const ui = useUi();
  const [stored, setD] = useLocal<Draft>("fpl.diagram.v1", DEFAULT_DRAFT);
  // Drafts saved by older versions lack the newer options.
  const d: Draft = { ...DEFAULT_DRAFT, ...stored, opts: migrateOpts(stored.opts), overrides: stored.overrides ?? {}, endNotes: stored.endNotes ?? {}, summary: { ...DEFAULT_DRAFT.summary, ...(stored.summary ?? {}) } };
  const [endEdit, setEndEdit] = useState<{ cid: string; end: "client" | "server"; x: number; y: number } | null>(null);
  const [custom, setCustom] = useState<{ id: string; x: number; y: number } | null>(null);
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [diagrams, setDiagrams] = useState<Versioned[]>([]);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "node"; id: string; dx: number; dy: number } | { kind: "pan"; sx: number; sy: number; vx: number; vy: number } | null>(null);

  const refresh = useCallback(() => api.diagrams.list().then(setDiagrams).catch(() => {}), []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  // Give any device without a saved position a spot from the automatic layout.
  const positions = useMemo(() => {
    const auto = autoLayout(devices, vlans);
    const p: Record<string, Pos> = {};
    for (const dev of devices) p[dev.id] = d.positions[dev.id] ?? auto[dev.id];
    return p;
  }, [devices, vlans, d.positions]);

  const pmap = useMemo(() => new Map(protocols.map((p) => [p.id, p])), [protocols]);
  const dmap = useMemo(() => new Map(devices.map((x) => [x.id, x])), [devices]);
  const vmap = useMemo(() => new Map(vlans.map((x) => [x.id, x])), [vlans]);
  const cmap = useMemo(() => new Map(cats.map((x) => [x.id, x])), [cats]);
  const full = useMemo(() => ({ ...h, vlans, devices }), [h, vlans, devices]);
  const svcOf = useCallback((dev: Device) => chainOf(dev, full).service, [full]);
  // Devices in hidden services / categories are left out, with their connections.
  const allowed = useMemo(() => {
    const hs = new Set(d.opts.hiddenServices);
    const hc = new Set(d.opts.hiddenCategories);
    return new Set(devices.filter((x) => !hs.has(svcOf(x)?.id ?? "none") && !hc.has(x.categoryId && cmap.has(x.categoryId) ? x.categoryId : "none")).map((x) => x.id));
  }, [devices, d.opts.hiddenServices, d.opts.hiddenCategories, svcOf, cmap]);
  const edges = useMemo(
    () => connections.filter((c) => c.fromId && c.toId && c.fromId !== c.toId && allowed.has(c.fromId) && allowed.has(c.toId) && c.protocolId && pmap.has(c.protocolId) && (!visible || visible.has(c.protocolId))),
    [connections, allowed, pmap, visible],
  );
  const connected = useMemo(() => new Set(edges.flatMap((c) => [c.fromId!, c.toId!])), [edges]);

  // ---------- summary: stable numbering over every drawable connection (filters only grey rows out) ----------
  const drawable = useMemo(
    () => connections.filter((c) => c.fromId && c.toId && c.fromId !== c.toId && dmap.has(c.fromId) && dmap.has(c.toId) && c.protocolId && pmap.has(c.protocolId)),
    [connections, dmap, pmap],
  );
  /** Connection ids in row order: saved arrangement first, new connections appended. */
  const numbered = useMemo(() => numberedIds(d.summary.order, drawable), [drawable, d.summary.order]);
  const numColors = d.summary.numColors ?? {};
  const setNumColor = (id: string, c: NumColor | null) =>
    setD((x) => {
      const sm = { ...DEFAULT_DRAFT.summary, ...(x.summary ?? {}) };
      const all = { ...(sm.numColors ?? {}) };
      if (c && (c.bg || c.fg)) all[id] = c;
      else delete all[id];
      return { ...x, summary: { ...sm, numColors: all } };
    });
  const numHold = useHold(HOLD_NUM_MS);
  const [numEdit, setNumEdit] = useState<{ id: string; x: number; y: number } | null>(null);
  const numOf = useMemo(() => new Map(numbered.map((id, i) => [id, i + 1])), [numbered]);
  const setSummary = (p: Partial<SummaryState>) => setD((x) => ({ ...x, summary: { ...DEFAULT_DRAFT.summary, ...(x.summary ?? {}), ...p } }));
  const moveRow = (id: string, to: number) => {
    const o = numbered.filter((x) => x !== id);
    o.splice(Math.max(0, Math.min(o.length, to)), 0, id);
    setSummary({ order: o });
  };
  const summaryRows = useMemo((): SummaryRow[] => {
    const nameOf = hopNamer(full);
    const edgeIds = new Set(edges.map((c) => c.id));
    const cmapc = new Map(drawable.map((c) => [c.id, c]));
    const endInfo = (c: Connection, end: "client" | "server"): EndInfo => {
      const dev = dmap.get((end === "client" ? c.fromId : c.toId) ?? "")!;
      const vid = c.endNet ? (end === "client" ? c.clientVlanId : c.serverVlanId) : dev.vlanId;
      const v = vid ? vmap.get(vid) : undefined;
      const ip = (c.endNet ? (end === "client" ? c.clientIp : c.serverIp) : dev.ip) ?? "";
      return {
        device: dev.name || "(unnamed)",
        port: (end === "client" ? c.clientPort : c.serverPort) ?? "",
        vlan: v ? v.vlan : "",
        ip: ip.trim(),
        service: chainOf(dev, full).service?.name ?? "",
      };
    };
    return numbered.map((id, i) => {
      const c = cmapc.get(id)!;
      const p = pmap.get(c.protocolId!)!;
      return {
        id, n: i + 1, color: p.style.color, shown: edgeIds.has(id),
        from: endInfo(c, "client"), to: endInfo(c, "server"),
        protocol: protocolLabel(p), svcPort: c.port.trim() || defaultPortOf(p, protocols), address: c.address,
        hops: (c.path ?? []).length, pathText: pathText(c, nameOf),
      };
    });
  }, [numbered, drawable, edges, dmap, vmap, pmap, protocols, full]);
  const shown = devices.filter((x) => allowed.has(x.id) && (!d.opts.hideUnconnected || connected.has(x.id)));
  const baseColor = (dev: Device) => {
    if (d.opts.colorBy === "service") return serviceColor(svcOf(dev), h.services);
    if (d.opts.colorBy === "category") return (dev.categoryId && cmap.get(dev.categoryId)?.color) || "#6b7782";
    return "";
  };
  const s = d.opts.nodeScale;
  const W = NODE_W * s;
  const H = NODE_H * s;

  /** Text of each bubble wrapped to the bubble width; the bubble grows to fit. */
  const layout = useMemo(() => {
    const inner = W - 20 * s;
    const out = new Map<string, { h: number; name: string[]; model: string[]; sub: string[]; note: string[] }>();
    for (const dev of devices) {
      const o = d.overrides[dev.id] ?? {};
      const cat = dev.categoryId ? cmap.get(dev.categoryId) : undefined;
      const svc = chainOf(dev, full).service;
      const f = d.opts.fields;
      const second = f
        .filter((x) => x !== "model")
        .map((x) => (x === "type" ? dev.type : x === "category" ? cat?.name : x === "service" ? svc?.name : dev.serial))
        .filter(Boolean)
        .join(" · ");
      const name = wrap(dev.name || "(unnamed)", inner / (CH.name * s), 2);
      const model = f.includes("model") && dev.model?.trim() ? wrap(dev.model, (inner - 10 * s) / (CH.pill * s), 2) : [];
      const sub = wrap(second, inner / (CH.sub * s), 4);
      const note = wrap(o.note, inner / (CH.note * s), MAX_LINES);
      const h =
        10 * s + name.length * 16 * s + (model.length ? 4 * s + model.length * 12 * s + 4 * s : 0) + (sub.length ? 2 * s + sub.length * 13 * s : 0) + (note.length ? 4 * s + note.length * 12 * s : 0) + 9 * s;
      out.set(dev.id, { h: Math.max(H, h), name, model, sub, note });
    }
    return out;
  }, [devices, d.overrides, d.opts.fields, cmap, full, W, H, s]);
  const hOf = (id: string) => layout.get(id)?.h ?? H;

  // Parallel connections between the same two devices fan out as curves.
  const geometry = useMemo(() => {
    const pairs = new Map<string, Connection[]>();
    for (const c of edges) {
      const k = [c.fromId, c.toId].sort().join("|");
      pairs.set(k, [...(pairs.get(k) ?? []), c]);
    }
    /** st/en: line ends (client / server side); t0/t1: unit direction of the line at each end, pointing along the line. */
    const g = new Map<string, { path: string; mid: Pos; st: Pos; en: Pos; t0: Pos; t1: Pos }>();
    const unit = (a: Pos, b: Pos) => {
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    };
    for (const list of pairs.values()) {
      list.forEach((c, i) => {
        const a = positions[c.fromId!];
        const b = positions[c.toId!];
        const ha = hOf(c.fromId!);
        const hb = hOf(c.toId!);
        const ac = { x: a.x + W / 2, y: a.y + ha / 2 };
        const bc = { x: b.x + W / 2, y: b.y + hb / 2 };
        // Normal is taken relative to a canonical direction so curves for A→B and B→A separate.
        const canonical = [c.fromId!, c.toId!].sort()[0] === c.fromId;
        const [p, q] = canonical ? [ac, bc] : [bc, ac];
        const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        const nx = -(q.y - p.y) / len;
        const ny = (q.x - p.x) / len;
        const off = (i - (list.length - 1) / 2) * 34 * Math.max(0.6, s);
        const ctrl = { x: (ac.x + bc.x) / 2 + nx * off * 2, y: (ac.y + bc.y) / 2 + ny * off * 2 };
        const prot = pmap.get(c.protocolId!)!;
        const gap = 2 + strokeWidth(prot.style) / 2;
        const st = exitPoint(ac.x, ac.y, W / 2, ha / 2, off ? ctrl.x : bc.x, off ? ctrl.y : bc.y, gap);
        const en = exitPoint(bc.x, bc.y, W / 2, hb / 2, off ? ctrl.x : ac.x, off ? ctrl.y : ac.y, gap);
        const path = off ? `M${st.x},${st.y} Q${ctrl.x},${ctrl.y} ${en.x},${en.y}` : `M${st.x},${st.y} L${en.x},${en.y}`;
        const mid = off ? { x: 0.25 * st.x + 0.5 * ctrl.x + 0.25 * en.x, y: 0.25 * st.y + 0.5 * ctrl.y + 0.25 * en.y } : { x: (st.x + en.x) / 2, y: (st.y + en.y) / 2 };
        g.set(c.id, { path, mid, st, en, t0: unit(st, off ? ctrl : en), t1: unit(off ? ctrl : st, en) });
      });
    }
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, positions, pmap, W, H, s, layout]);

  // ---------- pointer interaction ----------
  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - d.view.x) / d.view.k, y: (cy - r.top - d.view.y) / d.view.k };
  };
  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const onNodeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    drag.current = { kind: "node", id, dx: w.x - positions[id].x, dy: w.y - positions[id].y };
    setSelNode(id);
    setSelEdge(null);
    setCustom(null);
    // Click and hold (without moving) opens the bubble's colour / note editor.
    cancelHold();
    const cx = e.clientX;
    const cy = e.clientY;
    hold.current = {
      x: cx,
      y: cy,
      timer: window.setTimeout(() => {
        hold.current = null;
        drag.current = null;
        const r = canvasRef.current?.getBoundingClientRect();
        if (r) setCustom({ id, x: cx - r.left, y: cy - r.top });
      }, HOLD_MS),
    };
  };
  const onBgDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: d.view.x, vy: d.view.y };
    setSelNode(null);
    setSelEdge(null);
    setCustom(null);
    setEndEdit(null);
    setNumEdit(null);
  };
  const onMove = (e: React.PointerEvent) => {
    if (hold.current && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > 4) cancelHold();
    const g = drag.current;
    if (!g) return;
    if (g.kind === "pan") {
      setD((x) => ({ ...x, view: { ...x.view, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy } }));
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    let nx = w.x - g.dx;
    let ny = w.y - g.dy;
    if (d.opts.snap) {
      nx = Math.round(nx / GRID) * GRID;
      ny = Math.round(ny / GRID) * GRID;
    }
    setD((x) => ({ ...x, positions: { ...positions, ...x.positions, [g.id]: { x: nx, y: ny } } }));
  };
  const onUp = () => {
    cancelHold();
    drag.current = null;
  };
  useEffect(() => () => cancelHold(), []);
  const setEndNote = (cid: string, end: "client" | "server", text: string) =>
    setD((x) => {
      const all = { ...(x.endNotes ?? {}) };
      const cur = { ...(all[cid] ?? {}), [end]: text };
      if (!cur.client && !cur.server) delete all[cid];
      else all[cid] = cur;
      return { ...x, endNotes: all };
    });
  const setOverride = (id: string, o: NodeOverride | null) =>
    setD((x) => {
      const ov = { ...(x.overrides ?? {}) };
      if (o) ov[id] = { ...ov[id], ...o };
      else delete ov[id];
      return { ...x, overrides: ov };
    });
  const onWheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    setD((x) => {
      const k = Math.min(3, Math.max(0.2, x.view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      return { ...x, view: { k, x: mx - ((mx - x.view.x) * k) / x.view.k, y: my - ((my - x.view.y) * k) / x.view.k } };
    });
  };
  // Block page scroll while zooming the diagram.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  const fit = () => {
    const el = svgRef.current;
    const pts = shown.filter((x) => positions[x.id]).map((x) => ({ ...positions[x.id], h: hOf(x.id) }));
    if (!el || !pts.length) return;
    const r = el.getBoundingClientRect();
    // Extra margin leaves room for text placed around bubbles.
    const minX = Math.min(...pts.map((p) => p.x)) - 90;
    const minY = Math.min(...pts.map((p) => p.y)) - 60;
    const maxX = Math.max(...pts.map((p) => p.x)) + W + 90;
    const maxY = Math.max(...pts.map((p) => p.y + p.h)) + 60;
    const k = Math.min(2, Math.max(0.2, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    setD((x) => ({ ...x, view: { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k } }));
  };
  const setOpt = <K extends keyof DiagramOpts>(k: K, v: DiagramOpts[K]) => setD((x) => ({ ...x, opts: { ...migrateOpts(x.opts), [k]: v } }));
  const recolor = async (kind: "service" | "category", id: string, color: string) => {
    try {
      await (kind === "service" ? api.services.update(id, { color }) : api.categories.update(id, { color }));
      onNetChanged();
    } catch (e) {
      ui.toast(`Couldn’t save colour: ${errMsg(e)}`);
    }
  };

  // ---------- versions ----------
  const cur = diagrams.find((x) => x.id === d.lib.diagramId);
  const versions = cur?.versions ?? [];
  const summaryNow = { ...d.summary, order: numbered };
  const hash = hashOf({ positions, opts: d.opts, overrides: d.overrides, endNotes: d.endNotes, summary: summaryNow });
  const dirty = d.lib.savedHash !== hash;
  const exists = !!cur && versions.some((v) => sameVer(v, d.lib.pending));
  const setPending = (pending: Ver) => setD((x) => ({ ...x, lib: { ...x.lib, pending } }));

  const save = async () => {
    setBusy(true);
    try {
      let id = cur ? cur.id : null;
      if (!id) {
        const name = await ui.prompt("Diagram name", `Data flow ${stamp()}`, "Save diagram");
        if (!name) return;
        id = (await api.diagrams.create({ name })).id;
      }
      const p = d.lib.pending;
      const data: DiagramData = { positions, view: d.view, opts: d.opts, overrides: d.overrides, endNotes: d.endNotes, summary: summaryNow };
      const r = await api.diagrams.saveVersion(id, p.major, p.minor, { stamp: stamp(), data, meta: { devices: devices.length, connections: edges.length } });
      setD((x) => ({ ...x, positions, lib: { diagramId: id, loaded: p, pending: p, savedHash: hashOf({ positions, opts: d.opts, overrides: d.overrides, endNotes: d.endNotes, summary: summaryNow }) }, summary: summaryNow }));
      await refresh();
      ui.toast(`${r.created ? "Saved" : "Saved over"} diagram v${verLabel(p)}`);
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const load = async (id: string, v: Ver) => {
    if (dirty && !(await ui.confirm("The layout has unsaved changes. Load the saved version and discard them?", "Discard and load"))) return;
    try {
      const ver = await api.diagrams.getVersion(id, v.major, v.minor);
      const data = ver.data as DiagramData;
      const opts = migrateOpts(data.opts);
      const overrides = data.overrides ?? {};
      const endNotes = data.endNotes ?? {};
      const summary = { ...DEFAULT_DRAFT.summary, ...(data.summary ?? {}) };
      setD({
        positions: data.positions ?? {}, view: data.view ?? DEFAULT_DRAFT.view, opts, overrides, endNotes, summary,
        lib: { diagramId: id, loaded: { major: ver.major, minor: ver.minor }, pending: { major: ver.major, minor: ver.minor }, savedHash: hashOf({ positions: data.positions ?? {}, opts, overrides, endNotes, summary }) },
      });
      ui.toast(`Loaded diagram v${verLabel(ver)}`);
    } catch (e) {
      ui.toast(`Couldn’t load: ${errMsg(e)}`);
    }
  };

  const used = protocols.filter((p) => edges.some((c) => c.protocolId === p.id));
  const sel = selEdge ? connections.find((c) => c.id === selEdge) : null;
  const hl = (c: Connection) => (!selNode && !selEdge) || c.id === selEdge || c.fromId === selNode || c.toId === selNode;

  return (
    <div className="diagram">
      <div className="pane-head">
        <div className="toolbar" style={{ gap: "6px 10px" }}>
          <button type="button" onClick={fit} title="Fit all devices in view">Fit</button>
          <button type="button" onClick={() => setD((x) => ({ ...x, view: { ...x.view, k: Math.min(3, x.view.k * 1.2) } }))} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => setD((x) => ({ ...x, view: { ...x.view, k: Math.max(0.2, x.view.k / 1.2) } }))} aria-label="Zoom out">−</button>
          <span className="muted mono" style={{ fontSize: 12 }}>{Math.round(d.view.k * 100)}%</span>
          <button type="button" title="Place devices in columns by VLAN" onClick={async () => (await ui.confirm("Re-arrange all devices in columns by VLAN? Manual positions are replaced.", "Re-arrange")) && setD((x) => ({ ...x, positions: autoLayout(devices, vlans) }))}>Auto-arrange</button>
          <label className="ctl"><input type="checkbox" checked={d.opts.snap} onChange={(e) => setOpt("snap", e.target.checked)} /> Snap</label>
          <label className="ctl"><input type="checkbox" checked={d.opts.labels} onChange={(e) => setOpt("labels", e.target.checked)} /> Labels</label>
          <label className="ctl"><input type="checkbox" checked={d.opts.hideUnconnected} onChange={(e) => setOpt("hideUnconnected", e.target.checked)} /> Hide unconnected</label>
          <Popover label="Display options" align="left" button={<>Display…</>}>
            {() => (
              <div className="dg-display">
                <div className="row">
                  <span className="muted">Colour devices by</span>
                  <Seg label="Colour devices by" value={d.opts.colorBy} options={[["service", "Service"], ["category", "Category"], ["none", "None"]]} onChange={(v) => setOpt("colorBy", v)} />
                </div>
                <h5>Services</h5>
                {h.services.slice().sort((a, b) => a.sort - b.sort).map((sv) => (
                  <div key={sv.id} className="row">
                    <input type="checkbox" aria-label={`Show ${sv.name}`} checked={!d.opts.hiddenServices.includes(sv.id)} onChange={(e) => setOpt("hiddenServices", e.target.checked ? d.opts.hiddenServices.filter((x) => x !== sv.id) : [...d.opts.hiddenServices, sv.id])} />
                    <ColorPick label={`Colour of ${sv.name}`} value={serviceColor(sv, h.services)} onCommit={(c) => recolor("service", sv.id, c)} />
                    <span className="nm">{sv.name || "(unnamed)"}</span>
                    {sv.color && <button type="button" className="btn-ghost" title="Back to automatic colour" onClick={() => recolor("service", sv.id, "")}>↺</button>}
                  </div>
                ))}
                <div className="row">
                  <input type="checkbox" aria-label="Show devices without a service" checked={!d.opts.hiddenServices.includes("none")} onChange={(e) => setOpt("hiddenServices", e.target.checked ? d.opts.hiddenServices.filter((x) => x !== "none") : [...d.opts.hiddenServices, "none"])} />
                  <span className="sw" /><span className="nm muted">No service</span>
                </div>
                <h5>Categories</h5>
                {cats.map((ct) => (
                  <div key={ct.id} className="row">
                    <input type="checkbox" aria-label={`Show ${ct.name}`} checked={!d.opts.hiddenCategories.includes(ct.id)} onChange={(e) => setOpt("hiddenCategories", e.target.checked ? d.opts.hiddenCategories.filter((x) => x !== ct.id) : [...d.opts.hiddenCategories, ct.id])} />
                    <ColorPick label={`Colour of ${ct.name}`} value={ct.color} onCommit={(c) => recolor("category", ct.id, c)} />
                    <span className="nm">{ct.name}</span>
                  </div>
                ))}
                <div className="row">
                  <input type="checkbox" aria-label="Show devices without a category" checked={!d.opts.hiddenCategories.includes("none")} onChange={(e) => setOpt("hiddenCategories", e.target.checked ? d.opts.hiddenCategories.filter((x) => x !== "none") : [...d.opts.hiddenCategories, "none"])} />
                  <span className="sw" /><span className="nm muted">No category</span>
                </div>
                <h5>Device bubble shows</h5>
                <div className="row wrap">
                  {FIELD_ORDER.map((f) => (
                    <label key={f} className="ctl" title={f === "model" ? "Shown as a pill inside the bubble (set Model in Network → Devices)" : undefined}>
                      <input type="checkbox" checked={d.opts.fields.includes(f)} onChange={(e) => setOpt("fields", e.target.checked ? FIELD_ORDER.filter((x) => x === f || d.opts.fields.includes(x)) : d.opts.fields.filter((x) => x !== f))} />
                      {FIELD_LABEL[f]}
                    </label>
                  ))}
                </div>
                <h5>Connection ends</h5>
                <div className="row wrap">
                  <label className="ctl"><input type="checkbox" checked={d.opts.portTags} onChange={(e) => setOpt("portTags", e.target.checked)} /> Port tags (P1, ETH1…)</label>
                  <label className="ctl"><input type="checkbox" checked={d.opts.netVlan} onChange={(e) => setOpt("netVlan", e.target.checked)} /> VLAN</label>
                  <label className="ctl"><input type="checkbox" checked={d.opts.netIp} onChange={(e) => setOpt("netIp", e.target.checked)} /> IP</label>
                  <label className="ctl" title="Click a connection end (its port tag or ✎) to type a note there"><input type="checkbox" checked={d.opts.endNotes} onChange={(e) => setOpt("endNotes", e.target.checked)} /> End notes</label>
                </div>
                <p className="muted hint">Service and category colours are saved to the project. Hidden items, bubble fields, per-device customisation and end notes are part of this diagram’s saved layout. VLAN / IP come from the connection when it defines them per end, otherwise from the device. Click and hold a device for 0.5 s to customise it.</p>
              </div>
            )}
          </Popover>
          <button type="button" aria-pressed={d.summary.open} className={d.summary.open ? "on" : undefined} onClick={() => setSummary({ open: !d.summary.open })} title="Numbered summary of all connections">Summary</button>
          <label className="ctl">Node size
            <select value={d.opts.nodeScale} onChange={(e) => setOpt("nodeScale", +e.target.value)}>
              <option value={0.8}>S</option><option value={1}>M</option><option value={1.25}>L</option>
            </select>
          </label>
        </div>
        <div className="rightgrp">
          <div className="savegrp">
            <button type="button" className="save btn-primary" disabled={busy} onClick={save} title={(dirty ? "Unsaved layout changes. " : "") + (exists ? `Overwrites v${verLabel(d.lib.pending)}` : `Creates v${verLabel(d.lib.pending)}`)}>
              {dirty && <span className="dot" />}
              {(exists ? "Save v" : cur ? "Save as v" : "Save new v") + verLabel(d.lib.pending)}
            </button>
            <div className="bump">
              <button type="button" title="Next sub-version" onClick={() => setPending(bumpMinor(d.lib.pending, versions))}>+.001</button>
              <button type="button" title="Next version" onClick={() => setPending(bumpMajor(d.lib.pending, versions))}>+1.</button>
            </div>
            <button type="button" className="btn-ghost cancelch" disabled={!dirty || !d.lib.diagramId || !d.lib.loaded} title={d.lib.loaded ? `Discard the changes and go back to v${verLabel(d.lib.loaded)}` : "Nothing saved yet to go back to"}
              onClick={() => d.lib.diagramId && d.lib.loaded && load(d.lib.diagramId, d.lib.loaded)}>Cancel changes</button>
          </div>
          <LibraryBar
            store={api.diagrams}
            noun="diagram"
            recentAll
            profiles={diagrams}
            profileId={d.lib.diagramId}
            loaded={d.lib.loaded}
            onPickProfile={async (id) => {
              if (!id) {
                setD((x) => ({ ...x, lib: { diagramId: null, loaded: null, pending: V1, savedHash: null } }));
                return ui.toast("Next save creates a new diagram");
              }
              const v = latest(diagrams.find((x) => x.id === id)?.versions ?? []);
              if (v) await load(id, v);
            }}
            onLoad={(id, v) => load(id, v)}
            onChanged={refresh}
            onDetach={() => setD((x) => ({ ...x, lib: { diagramId: null, loaded: null, pending: V1, savedHash: null } }))}
          />
        </div>
      </div>
      <div className="dg-body">
      <div className="canvas" ref={canvasRef}>
        {custom && dmap.has(custom.id) && (() => {
          const dev = dmap.get(custom.id)!;
          const o = d.overrides[dev.id] ?? {};
          return (
            <div className="nodeed" role="dialog" aria-label={`Customise ${dev.name}`} style={{ left: Math.min(custom.x, (canvasRef.current?.clientWidth ?? 600) - 290), top: custom.y + 12 }} onPointerDown={(e) => e.stopPropagation()}>
              <div className="hd"><b>{dev.name || "(unnamed)"}</b><button type="button" className="btn-ghost" aria-label="Close" onClick={() => setCustom(null)}>✕</button></div>
              <div className="row">
                <span>Bubble colour</span>
                <ColorPick label="Bubble colour" value={o.color || baseColor(dev) || "#6b7782"} onCommit={(c) => setOverride(dev.id, { color: c })} />
                {o.color ? <button type="button" className="btn-ghost" onClick={() => setOverride(dev.id, { color: undefined })}>Use {d.opts.colorBy === "none" ? "default" : d.opts.colorBy} colour</button> : <span className="muted">from {d.opts.colorBy}</span>}
              </div>
              <label className="f">Note (inside, bottom-right · up to 3 lines)
                <textarea rows={2} aria-label="Customisation note" value={o.note ?? ""} autoFocus onChange={(e) => setOverride(dev.id, { note: clip3(e.target.value) })} />
              </label>
              <div className="row">
                <span>Note colour</span>
                <ColorPick label="Note colour" value={o.noteColor || NOTE_COLOR} onCommit={(c) => setOverride(dev.id, { noteColor: c })} />
              </div>
              <div className="sidegrid" aria-label="Text around the bubble">
                <span className="muted cap">Text around the bubble (up to 3 lines each, shown only when filled in)</span>
                <textarea rows={3} className="t" aria-label="Text above" placeholder="Above" value={o.textTop ?? ""} onChange={(e) => setOverride(dev.id, { textTop: clip3(e.target.value) })} />
                <textarea rows={3} className="l" aria-label="Text left" placeholder="Left" value={o.textLeft ?? ""} onChange={(e) => setOverride(dev.id, { textLeft: clip3(e.target.value) })} />
                <span className="c" aria-hidden="true">{dev.name || "device"}</span>
                <textarea rows={3} className="r" aria-label="Text right" placeholder="Right" value={o.textRight ?? ""} onChange={(e) => setOverride(dev.id, { textRight: clip3(e.target.value) })} />
                <textarea rows={3} className="b" aria-label="Text below" placeholder="Below" value={o.textBottom ?? ""} onChange={(e) => setOverride(dev.id, { textBottom: clip3(e.target.value) })} />
              </div>
              <div className="row">
                <span>Text colour</span>
                <ColorPick label="Text colour" value={o.sideColor || "#4a5560"} onCommit={(c) => setOverride(dev.id, { sideColor: c })} />
                {o.sideColor && <button type="button" className="btn-ghost" onClick={() => setOverride(dev.id, { sideColor: undefined })}>Default</button>}
              </div>
              <div className="ft">
                <button type="button" className="btn-danger" disabled={!hasOverride(o)} onClick={() => setOverride(dev.id, null)}>Clear customisation</button>
                <button type="button" className="btn-primary" onClick={() => setCustom(null)}>Done</button>
              </div>
            </div>
          );
        })()}
        {numEdit && numOf.has(numEdit.id) && (() => {
          const c = connections.find((x) => x.id === numEdit.id);
          const p = c ? pmap.get(c.protocolId ?? "") : undefined;
          if (!c || !p) return null;
          return (
            <NumColorEditor
              n={numOf.get(c.id)!}
              value={numColors[c.id]}
              lineColor={p.style.color}
              x={Math.min(numEdit.x, (canvasRef.current?.clientWidth ?? 600) - 280)}
              y={numEdit.y + 12}
              onChange={(v) => setNumColor(c.id, v)}
              onClose={() => setNumEdit(null)}
            />
          );
        })()}
        {endEdit && (() => {
          const c = connections.find((x) => x.id === endEdit.cid);
          if (!c) return null;
          const devName = dmap.get((endEdit.end === "client" ? c.fromId : c.toId) ?? "")?.name ?? "?";
          const val = d.endNotes[c.id]?.[endEdit.end] ?? "";
          return (
            <div className="nodeed" role="dialog" aria-label="Connection end note" style={{ left: Math.min(endEdit.x, (canvasRef.current?.clientWidth ?? 600) - 290), top: endEdit.y + 12 }} onPointerDown={(e) => e.stopPropagation()}>
              <div className="hd"><b>Note at {devName} ({endEdit.end === "client" ? "client" : "server"} end)</b><button type="button" className="btn-ghost" aria-label="Close" onClick={() => setEndEdit(null)}>✕</button></div>
              <textarea rows={3} autoFocus aria-label="End note" value={val} onChange={(e) => setEndNote(c.id, endEdit.end, clip3(e.target.value))} />
              <span className="muted" style={{ fontSize: 11.5 }}>Up to 3 lines, wraps in the diagram. Saved with this diagram’s layout.</span>
              <div className="ft">
                <button type="button" className="btn-danger" disabled={!val} onClick={() => setEndNote(c.id, endEdit.end, "")}>Clear</button>
                <button type="button" className="btn-primary" onClick={() => setEndEdit(null)}>Done</button>
              </div>
            </div>
          );
        })()}
        {!devices.length ? (
          <div className="empty-state"><h3>No devices yet</h3><p>Add devices in Network → Devices, then connections in the Connection list.</p></div>
        ) : (
          <svg
            ref={svgRef}
            className="dg"
            onPointerDown={onBgDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            onWheel={onWheel}
            role="img"
            aria-label="Data flow diagram"
          >
            <MarkerDefs protocols={protocols} prefix="dg" />
            <defs>
              <pattern id="dg-grid" width={GRID * 2} height={GRID * 2} patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.8" className="gridDot" />
              </pattern>
            </defs>
            <g transform={`translate(${d.view.x},${d.view.y}) scale(${d.view.k})`}>
              <rect x={-5000} y={-5000} width={10000} height={10000} fill="url(#dg-grid)" />
              {edges.map((c) => {
                const p = pmap.get(c.protocolId!)!;
                const g = geometry.get(c.id);
                if (!g) return null;
                const st = p.style;
                const startHead = c.bidirectional ? st.endHead : st.startHead;
                const on = hl(c);
                return (
                  <g key={c.id} className="edge" opacity={on ? 1 : 0.18} onPointerDown={(e) => (e.stopPropagation(), setSelEdge(c.id), setSelNode(null))}>
                    <path d={g.path} className="hit" />
                    <path
                      d={g.path}
                      fill="none"
                      stroke={st.color}
                      strokeOpacity={st.opacity}
                      strokeWidth={strokeWidth(st) * (c.id === selEdge ? 1.6 : 1)}
                      strokeDasharray={dashArray(st)}
                      strokeLinecap={st.dash === "dotted" || st.dash === "dashdot" ? "round" : "butt"}
                      markerStart={startHead !== "none" ? `url(#${markerId("dg", p.id, startHead)})` : undefined}
                      markerEnd={st.endHead !== "none" ? `url(#${markerId("dg", p.id, st.endHead)})` : undefined}
                    >
                      <title>{`${dmap.get(c.fromId!)?.name} → ${dmap.get(c.toId!)?.name} · ${p.name}${c.port ? ` :${c.port}` : ""}${c.address ? ` · addr ${c.address}` : ""}`}</title>
                    </path>

                  </g>
                );
              })}
              {shown.map((dev) => {
                const pos = positions[dev.id];
                const o = d.overrides[dev.id] ?? {};
                const color = o.color || baseColor(dev);
                const cat = dev.categoryId ? cmap.get(dev.categoryId) : undefined;
                const svc = svcOf(dev);
                const L = layout.get(dev.id)!;
                const NH = L.h;
                const on = !selNode || selNode === dev.id || edges.some((c) => (c.fromId === selNode && c.toId === dev.id) || (c.toId === selNode && c.fromId === dev.id));
                let y = 10 * s;
                const nameY = L.name.map(() => (y += 16 * s) - 3 * s);
                const modelTop = L.model.length ? (y += 4 * s) : 0;
                if (L.model.length) y += L.model.length * 12 * s + 4 * s;
                if (L.sub.length) y += 2 * s;
                const subY = L.sub.map(() => (y += 13 * s) - 2 * s);
                const pillW = L.model.length ? Math.min(W - 20 * s, Math.max(...L.model.map((m) => m.length)) * CH.pill * s + 12 * s) : 0;
                // Side text (top / bottom / left / right), wrapped to the bubble width, 3 lines max.
                const sideFill = o.sideColor || undefined;
                const side = (txt: string | undefined, width: number) => wrap(txt, width / (CH.side * s), MAX_LINES);
                const top = side(o.textTop, W);
                const bottom = side(o.textBottom, W);
                const left = side(o.textLeft, W * 0.8);
                const right = side(o.textRight, W * 0.8);
                const LH = 12.5 * s;
                return (
                  <g
                    key={dev.id}
                    className={`node${selNode === dev.id ? " sel" : ""}`}
                    transform={`translate(${pos.x},${pos.y})`}
                    opacity={on ? 1 : 0.35}
                    onPointerDown={(e) => onNodeDown(e, dev.id)}
                  >
                    <rect width={W} height={NH} rx={7} className="base" />
                    {color && (
                      <>
                        <rect width={W} height={NH} rx={7} fill={color} fillOpacity={0.14} stroke={color} strokeWidth={1.4} className="tint" />
                        <rect x={0} y={0} width={4} height={NH} rx={2} fill={color} />
                      </>
                    )}
                    {L.name.map((t, i) => <text key={`n${i}`} x={12 * s} y={nameY[i]} className="nm" style={{ fontSize: 13 * s }}>{t}</text>)}
                    {L.model.length > 0 && (
                      <g className="modelpill">
                        <rect x={12 * s} y={modelTop} width={pillW} height={L.model.length * 12 * s + 4 * s} rx={6 * s} fill={color || "var(--sunk)"} fillOpacity={color ? 0.22 : 1} stroke={color || "var(--line-strong)"} strokeWidth={1} />
                        {L.model.map((t, i) => <text key={i} className="mp" x={18 * s} y={modelTop + (i + 1) * 12 * s - 1 * s} style={{ fontSize: 9.5 * s }}>{t}</text>)}
                      </g>
                    )}
                    {L.sub.map((t, i) => <text key={`s${i}`} x={12 * s} y={subY[i]} className="sub" style={{ fontSize: 10.5 * s }}>{t}</text>)}
                    {L.note.length > 0 && (
                      <text textAnchor="end" className="note" fill={o.noteColor || NOTE_COLOR} style={{ fontSize: 10 * s }}>
                        {L.note.map((t, i) => <tspan key={i} x={W - 8 * s} y={NH - 8 * s - (L.note.length - 1 - i) * 12 * s}>{t}</tspan>)}
                        <title>{o.note}</title>
                      </text>
                    )}
                    {top.length > 0 && (
                      <text className="side" textAnchor="middle" style={{ fontSize: 10.5 * s, fill: sideFill }}>
                        {top.map((t, i) => <tspan key={i} x={W / 2} y={-6 * s - (top.length - 1 - i) * LH}>{t}</tspan>)}
                      </text>
                    )}
                    {bottom.length > 0 && (
                      <text className="side" textAnchor="middle" style={{ fontSize: 10.5 * s, fill: sideFill }}>
                        {bottom.map((t, i) => <tspan key={i} x={W / 2} y={NH + 13 * s + i * LH}>{t}</tspan>)}
                      </text>
                    )}
                    {left.length > 0 && (
                      <text className="side" textAnchor="end" style={{ fontSize: 10.5 * s, fill: sideFill }}>
                        {left.map((t, i) => <tspan key={i} x={-8 * s} y={NH / 2 + 4 * s + (i - (left.length - 1) / 2) * LH}>{t}</tspan>)}
                      </text>
                    )}
                    {right.length > 0 && (
                      <text className="side" textAnchor="start" style={{ fontSize: 10.5 * s, fill: sideFill }}>
                        {right.map((t, i) => <tspan key={i} x={W + 8 * s} y={NH / 2 + 4 * s + (i - (right.length - 1) / 2) * LH}>{t}</tspan>)}
                      </text>
                    )}
                    <title>{`${dev.name}${dev.model ? ` · ${dev.model}` : ""}${svc ? ` · ${svc.name}` : ""}${cat ? ` · ${cat.name}` : ""}${hasOverride(o) ? " · customised" : ""}\nClick and hold to change the colour or add notes / text`}</title>
                  </g>
                );
              })}
              {/* Port tags and VLAN / IP labels sit above the device bubbles so they stay readable. */}
              {edges.map((c) => {
                const p = pmap.get(c.protocolId!)!;
                const g = geometry.get(c.id);
                if (!g) return null;
                const st = p.style;
                return (
                  <g key={`t:${c.id}`} opacity={hl(c) ? 1 : 0.18}>
                    {(d.opts.labels || (d.summary.numbers && numOf.has(c.id))) && (() => {
                      // Row number from the summary: a square just left of the protocol label.
                      const lbl = protocolLabel(p);
                      const lw = d.opts.labels ? lbl.length * 7.2 + 12 : 0;
                      const num = d.summary.numbers ? String(numOf.get(c.id) ?? "") : "";
                      const nw = num ? Math.max(16, num.length * 7 + 7) : 0;
                      const gapN = num && lw ? 3 : 0;
                      const total = lw + nw + gapN;
                      return (
                        <g transform={`translate(${g.mid.x},${g.mid.y}) scale(${Math.max(0.75, st.scale)})`} className="elabel" onPointerDown={(e) => (e.stopPropagation(), setSelEdge(c.id), setSelNode(null))}>
                          {num && (() => {
                            const ns = numStyle(numColors[c.id], st.color);
                            return (
                              <g
                                className="lnum"
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  setSelEdge(c.id);
                                  setSelNode(null);
                                  numHold.start(e, (x, y) => {
                                    const r = canvasRef.current?.getBoundingClientRect();
                                    if (r) setNumEdit({ id: c.id, x: x - r.left, y: y - r.top });
                                  });
                                }}
                                onPointerMove={numHold.move}
                                onPointerUp={numHold.end}
                                onPointerLeave={numHold.end}
                              >
                                <rect x={-total / 2} y={-8} width={nw} height={16} rx={2.5} style={{ fill: ns.bg, stroke: ns.bg }} />
                                <text x={-total / 2 + nw / 2} textAnchor="middle" dy="4" style={{ fill: ns.fg }}>{num}</text>
                                <title>{`Row ${num} · click and hold to change its colours`}</title>
                              </g>
                            );
                          })()}
                          {lw > 0 && (
                            <>
                              <rect x={-total / 2 + nw + gapN} y={-8} width={lw} height={16} rx={4} stroke={st.color} />
                              <text x={-total / 2 + nw + gapN + lw / 2} textAnchor="middle" dy="4" fill={st.color}>{lbl}</text>
                            </>
                          )}
                        </g>
                      );
                    })()}
                    {(["client", "server"] as const).map((end) => {
                      // Port tag sits on the line just clear of the arrow head; VLAN / IP and the end note sit beside it.
                      const base = end === "client" ? g.st : g.en;
                      const t = end === "client" ? g.t0 : { x: -g.t1.x, y: -g.t1.y };
                      const reach = headSize(st) + 12;
                      const at = { x: base.x + t.x * reach, y: base.y + t.y * reach };
                      const tag = d.opts.portTags ? portAbbr(end === "client" ? c.clientPort : c.serverPort) : "";
                      // The connection's own per-end values when defined, otherwise the device's IP / VLAN.
                      const dev = dmap.get((end === "client" ? c.fromId : c.toId) ?? "");
                      const vid = c.endNet ? (end === "client" ? c.clientVlanId : c.serverVlanId) : dev?.vlanId;
                      const ip = (c.endNet ? (end === "client" ? c.clientIp : c.serverIp) : dev?.ip)?.trim();
                      const v = vid ? vmap.get(vid) : undefined;
                      const net = [d.opts.netVlan && v ? `VLAN ${v.vlan}` : "", d.opts.netIp && ip ? ip : ""].filter(Boolean);
                      const noteText = d.opts.endNotes ? d.endNotes[c.id]?.[end] ?? "" : "";
                      const note = noteText ? wrap(noteText, 28, MAX_LINES) : [];
                      const editable = d.opts.endNotes;
                      if (!tag && !net.length && !note.length && !editable) return null;
                      // Block starts at the device edge and runs into the gap: below a horizontal line, right of a vertical one.
                      const vertical = Math.abs(t.y) > Math.abs(t.x);
                      const tw = tag ? tag.length * 6.2 + 10 : 0;
                      const anchor: "start" | "end" = vertical ? "start" : t.x > 0 ? "start" : "end";
                      const netH = net.length ? net.length * 12 + 6 : 0;
                      const blockH = netH + (note.length ? note.length * 12 + (netH ? 3 : 0) : 0);
                      const bx = vertical ? at.x + Math.max(tw / 2, 6) + 5 : base.x + t.x * 3;
                      const by = vertical ? (t.y > 0 ? base.y + 2 : base.y - 4 - blockH) : base.y + Math.abs(t.y) * 8 + 8;
                      const netW = net.length ? Math.max(...net.map((x) => x.length)) * CH.net + 10 : 0;
                      const nx = anchor === "start" ? bx : bx - netW;
                      const openEditor = (e: React.PointerEvent) => {
                        if (!editable) return;
                        e.stopPropagation();
                        const r = canvasRef.current?.getBoundingClientRect();
                        if (r) setEndEdit({ cid: c.id, end, x: e.clientX - r.left, y: e.clientY - r.top });
                      };
                      return (
                        <g key={end} className={`endtag${editable ? " editable" : ""}`} onPointerDown={openEditor}>
                          {tag ? (
                            <g transform={`translate(${at.x},${at.y})`}>
                              <rect x={-tw / 2} y={-7.5} width={tw} height={15} rx={7.5} fill={st.color} />
                              <text textAnchor="middle" dy="3.4" className="ptag">{tag}</text>
                            </g>
                          ) : editable && !note.length ? (
                            <g transform={`translate(${at.x},${at.y})`} className="addnote">
                              <circle r={6.5} fill="var(--surface)" stroke={st.color} strokeWidth={1} />
                              <text textAnchor="middle" dy="3" style={{ fill: st.color }}>✎</text>
                              <title>Add a note at this end</title>
                            </g>
                          ) : null}
                          {net.length > 0 && (
                            <g className="netbub">
                              <rect x={nx} y={by} width={netW} height={netH} rx={5} fill="var(--surface)" stroke={st.color} strokeWidth={1} />
                              <text className="netlbl" fill={st.color}>
                                {net.map((line, i) => <tspan key={i} x={nx + 5} y={by + 12 + i * 12}>{line}</tspan>)}
                              </text>
                              <title>{[v && `VLAN ${v.vlan}${v.name ? ` — ${v.name}` : ""} (${v.subnet})`, ip, c.endNet ? "set on this connection" : "from the device"].filter(Boolean).join("\n")}</title>
                            </g>
                          )}
                          {note.length > 0 && (
                            <text className="endnote" textAnchor={anchor} fill={st.color}>
                              {note.map((line, i) => <tspan key={i} x={anchor === "start" ? bx + 2 : bx - 2} y={by + netH + (netH ? 3 : 0) + 10 + i * 12}>{line}</tspan>)}
                              <title>{noteText}</title>
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
      {d.summary.open && (
        <SummaryPanel
          rows={summaryRows}
          cols={d.summary.cols}
          onCols={(cols) => setSummary({ cols })}
          onMove={moveRow}
          selected={selEdge}
          related={new Set(selNode ? edges.filter((c) => c.fromId === selNode || c.toId === selNode).map((c) => c.id) : [])}
          onSelect={(id) => {
            setSelEdge(id);
            setSelNode(null);
          }}
          numColors={numColors}
          onNumColor={setNumColor}
          numbers={d.summary.numbers}
          onNumbers={(numbers) => setSummary({ numbers })}
          onClose={() => setSummary({ open: false })}
        />
      )}
      </div>
      <div className="dg-foot">
        {sel ? (
          <span>
            <b>{dmap.get(sel.fromId!)?.name}</b> → <b>{dmap.get(sel.toId!)?.name}</b> · {pmap.get(sel.protocolId!)?.name}
            {sel.port && ` · port ${sel.port}`}{sel.address && ` · address ${sel.address}`}{sel.bidirectional && " · bidirectional"}{sel.topic && ` · ${sel.topic}`}
          </span>
        ) : (
          <span className="muted">Drag devices to move them · drag the background to pan · scroll to zoom · click a device or line to highlight its connections.</span>
        )}
        <span className="legend-row">
          {d.opts.colorBy === "service" && h.services.filter((sv) => shown.some((x) => svcOf(x)?.id === sv.id)).map((sv) => (
            <span key={sv.id} className="lg"><i className="catdot" style={{ background: serviceColor(sv, h.services) }} />{sv.name}</span>
          ))}
          {d.opts.colorBy === "category" && cats.filter((ct) => shown.some((x) => x.categoryId === ct.id)).map((ct) => (
            <span key={ct.id} className="lg"><i className="catdot" style={{ background: ct.color }} />{ct.name}</span>
          ))}
          {used.map((p) => (
            <span key={p.id} className="lg"><LinePreview p={p} width={46} />{protocolLabel(p)}</span>
          ))}
        </span>
        <span className="muted">{edges.length} connections · {shown.length} devices{cur ? ` · ${cur.name}${d.lib.loaded ? ` v${verLabel(d.lib.loaded)}` : ""}` : ""}{dirty ? " · unsaved layout" : ""}</span>
      </div>
    </div>
  );
}
