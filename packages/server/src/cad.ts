/**
 * CAD imports for part 2D views:
 *   STEP → overall x/y/z (bounding box) and six orthographic views (front, back, top, bottom, left, right) as SVG,
 *          drawn face by face (painter's order, shaded by orientation and depth, with face outlines);
 *   DXF  → SVG (one view), with its extents in mm from $INSUNITS;
 *   SVG  → cleaned SVG with its extents.
 */
import { VIEW_NAMES, type ViewName } from "@fpl/core";
import { Helper } from "dxf";
import occtimportjs from "occt-import-js";

type Vec = [number, number, number];
export type Axis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
export const AXES: Axis[] = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];

/**
 * Turn the device by 90° as seen from its front view. Device axes: X right, Y up, Z out of the front (towards the viewer).
 *   z+  about the viewing axis, counter-clockwise (left): the side that was on the right comes up
 *   z-  about the viewing axis, clockwise (right): the side that was on the left comes up
 *   x+  about the horizontal axis, top towards the viewer: the old top becomes the front, the old back becomes the top
 *   x-  about the horizontal axis, top away from the viewer: the old bottom becomes the front, the old front becomes the top
 *   y+  about the vertical axis, turning left (counter-clockwise seen from above): the old left side becomes the front
 *   y-  about the vertical axis, turning right (clockwise seen from above): the old right side becomes the front
 * Returns the model axes now pointing up and out of the front.
 */
export type Rot = "z+" | "z-" | "x+" | "x-" | "y+" | "y-";
export function rotateOrientation(up: Axis, front: Axis, rot: Rot): { up: Axis; front: Axis } {
  const Y = axisVec(up);
  const Z = axisVec(front);
  const X = cross(Y, Z);
  const neg = (v: Vec): Vec => [-v[0], -v[1], -v[2]];
  const [nu, nf] =
    rot === "z+" ? [X, Z] : rot === "z-" ? [neg(X), Z] : rot === "x+" ? [neg(Z), Y] : rot === "x-" ? [Z, neg(Y)] : rot === "y+" ? [Y, neg(X)] : [Y, X];
  return { up: vecAxis(nu), front: vecAxis(nf) };
}
function vecAxis(v: Vec): Axis {
  const k = v.findIndex((c) => Math.abs(c) > 0.5);
  return `${v[k] < 0 ? "-" : "+"}${"XYZ"[k]}` as Axis;
}
const axisVec = (a: Axis): Vec => {
  const s = a[0] === "-" ? -1 : 1;
  return a[1] === "X" ? [s, 0, 0] : a[1] === "Y" ? [0, s, 0] : [0, 0, s];
};
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec): Vec => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

let occtP: Promise<Awaited<ReturnType<typeof occtimportjs>>> | null = null;
const occt = () => (occtP ??= occtimportjs());

/** Per view: screen right (u), screen up (v) and the direction towards the viewer, in device axes (x right, y up, z out of the front). */
const VIEW_FRAME: Record<ViewName, { u: Vec; v: Vec; toViewer: Vec }> = {
  front: { u: [1, 0, 0], v: [0, 1, 0], toViewer: [0, 0, 1] },
  back: { u: [-1, 0, 0], v: [0, 1, 0], toViewer: [0, 0, -1] },
  top: { u: [1, 0, 0], v: [0, 0, -1], toViewer: [0, 1, 0] },
  bottom: { u: [1, 0, 0], v: [0, 0, 1], toViewer: [0, -1, 0] },
  left: { u: [0, 0, 1], v: [0, 1, 0], toViewer: [-1, 0, 0] },
  right: { u: [0, 0, -1], v: [0, 1, 0], toViewer: [1, 0, 0] },
};

export interface StepResult {
  dims: { x: number; y: number; z: number };
  views: Record<ViewName, { svg: string; wMm: number; hMm: number }>;
  triangles: number;
}

/**
 * Read a STEP file and draw its six views. `up` is the model axis pointing up on the device; `front` the model axis
 * pointing out of the device's front face (towards someone looking at the front).
 */
export async function stepToViews(buf: Buffer, up: Axis = "+Z", front: Axis = "-Y"): Promise<StepResult> {
  const Y = axisVec(up);
  const Z = axisVec(front);
  if (Math.abs(dot(Y, Z)) > 0.5) throw Object.assign(new Error("Up and front must be different axes"), { statusCode: 400 });
  const X = cross(Y, Z);
  const o = await occt();
  const r = o.ReadStepFile(new Uint8Array(buf), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.5 });
  if (!r.success || !r.meshes?.length) throw Object.assign(new Error("Could not read the STEP file (no solid geometry found)"), { statusCode: 400 });

  // Faces in device coordinates: triangles (3 points each) and their normals.
  interface Face { tris: Vec[][]; norms: Vec[] }
  const faces: Face[] = [];
  const min: Vec = [Infinity, Infinity, Infinity];
  const max: Vec = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const m of r.meshes) {
    const pos = m.attributes.position.array as number[];
    const nrm = (m.attributes.normal?.array ?? []) as number[];
    const idx = (m.index?.array ?? []) as number[];
    const P = (i: number): Vec => {
      const p: Vec = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
      return [dot(p, X), dot(p, Y), dot(p, Z)];
    };
    const N = (i: number): Vec => (nrm.length ? [dot([nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]], X), dot([nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]], Y), dot([nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]], Z)] : [0, 0, 0]);
    const ranges = (m.brep_faces?.length ? m.brep_faces : [{ first: 0, last: idx.length / 3 - 1 }]) as { first: number; last: number }[];
    for (const f of ranges) {
      const face: Face = { tris: [], norms: [] };
      for (let t = f.first; t <= f.last; t++) {
        const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
        const tri = [P(a), P(b), P(c)];
        let n = norm(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
        const vn = N(a);
        // Keep the geometric normal pointing the same way as the supplied vertex normal (outward).
        if (dot(vn, vn) > 0 && dot(n, vn) < 0) n = [-n[0], -n[1], -n[2]];
        face.tris.push(tri);
        face.norms.push(n);
        for (const p of tri) for (let k = 0; k < 3; k++) ((min[k] = Math.min(min[k], p[k])), (max[k] = Math.max(max[k], p[k])));
        triangles++;
      }
      if (face.tris.length) faces.push(face);
    }
  }
  const dims = { x: round(max[0] - min[0]), y: round(max[1] - min[1]), z: round(max[2] - min[2]) };
  const views = {} as StepResult["views"];
  for (const v of VIEW_NAMES) views[v] = drawView(faces, VIEW_FRAME[v], min, max);
  return { dims, views, triangles };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function drawView(faces: { tris: Vec[][]; norms: Vec[] }[], fr: { u: Vec; v: Vec; toViewer: Vec }, min: Vec, max: Vec) {
  const corners: Vec[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
  const us = corners.map((c) => dot(c, fr.u));
  const vs = corners.map((c) => dot(c, fr.v));
  const ds = corners.map((c) => dot(c, fr.toViewer));
  const u0 = Math.min(...us), v1 = Math.max(...vs), d0 = Math.min(...ds), d1 = Math.max(...ds);
  const W = round(Math.max(...us) - u0), Hh = round(v1 - Math.min(...vs));
  const proj = (p: Vec) => [round(dot(p, fr.u) - u0), round(v1 - dot(p, fr.v))] as const;
  const parts: { depth: number; d: string; edges: string; shade: number }[] = [];
  for (const f of faces) {
    let sumD = 0, sumS = 0, n = 0;
    let d = "";
    const edgeCount = new Map<string, number>();
    const edgeSeg = new Map<string, string>();
    f.tris.forEach((tri, i) => {
      const facing = dot(f.norms[i], fr.toViewer);
      if (facing <= 0.02) return;
      const q = tri.map(proj);
      const area = Math.abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]));
      if (area < 1e-4) return;
      d += `M${q[0][0]} ${q[0][1]}L${q[1][0]} ${q[1][1]}L${q[2][0]} ${q[2][1]}Z`;
      for (let k = 0; k < 3; k++) {
        const a = q[k], b = q[(k + 1) % 3];
        const key = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? `${a[0]},${a[1]},${b[0]},${b[1]}` : `${b[0]},${b[1]},${a[0]},${a[1]}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
        edgeSeg.set(key, `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`);
      }
      sumD += tri.reduce((s, p) => s + dot(p, fr.toViewer), 0) / 3;
      sumS += facing;
      n++;
    });
    if (!n) continue;
    // Outline = edges used by one visible triangle only (the face boundary).
    let edges = "";
    for (const [k, c] of edgeCount) if (c === 1) edges += edgeSeg.get(k);
    const depth = sumD / n;
    const rel = d1 > d0 ? (depth - d0) / (d1 - d0) : 1;
    parts.push({ depth, d, edges, shade: (0.45 + 0.4 * (sumS / n)) * (0.6 + 0.4 * rel) });
  }
  parts.sort((a, b) => a.depth - b.depth);
  const sw = round(Math.max(W, Hh) / 900, 3) || 0.2;
  const body = parts
    .map((p) => {
      const g = Math.round(255 * Math.min(1, Math.max(0.15, p.shade)));
      const c = `rgb(${g},${g},${Math.min(255, g + 6)})`;
      return `<path d="${p.d}" fill="${c}" stroke="${c}" stroke-width="${sw / 2}"/><path d="${p.edges}" fill="none" stroke="#2b3238" stroke-width="${sw}"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" width="${W}mm" height="${Hh}mm" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
  return { svg, wMm: W, hMm: Hh };
}

const UNIT_MM: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0254, 9: 0.0254 * 1e-3 };

/** DXF → SVG (y up handled by the converter) with its extents in mm. */
export function dxfToSvg(text: string): { svg: string; wMm: number | null; hMm: number | null; unitsNote: string } {
  let h: Helper;
  try {
    h = new Helper(text);
  } catch (e) {
    throw Object.assign(new Error(`Could not read the DXF: ${(e as Error).message}`), { statusCode: 400 });
  }
  let svg = h.toSVG();
  const vb = svg.match(/viewBox="([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)"/);
  const units = Number((h.parsed.header as { insUnits?: number }).insUnits ?? 0);
  const f = UNIT_MM[units] ?? 1;
  const w = vb ? Number(vb[3]) * f : null;
  const hh = vb ? Number(vb[4]) * f : null;
  // Fixed line width instead of a percentage of the viewport, and no width/height so it scales to its box.
  svg = svg.replace(/<\?xml[^>]*>\s*/, "").replace(/stroke-width="[\d.]+%"/, `stroke-width="${vb ? Math.max(Number(vb[3]), Number(vb[4])) / 600 : 0.5}"`).replace(/\swidth="100%"\s+height="100%"/, "");
  return { svg, wMm: w, hMm: hh, unitsNote: UNIT_MM[units] ? "" : "DXF units not set; read as millimetres" };
}

/** Remove scripts, event handlers and external references; return extents from the viewBox / width / height (mm when given in mm or in). */
export function cleanSvg(text: string): { svg: string; wMm: number | null; hMm: number | null } {
  let s = text.replace(/<\?xml[^>]*>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "");
  s = s.replace(/(href|xlink:href)\s*=\s*("|')(?!#|data:image\/)[^"']*\2/gi, "");
  const open = s.match(/<svg\b[^>]*>/i)?.[0];
  if (!open) throw Object.assign(new Error("Not an SVG file"), { statusCode: 400 });
  const attr = (n: string) => open.match(new RegExp(`\\s${n}="([^"]+)"`))?.[1];
  const len = (v?: string) => {
    if (!v) return null;
    const m = v.match(/^([\d.]+)\s*(mm|cm|in|px|pt)?$/);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === "mm" ? n : m[2] === "cm" ? n * 10 : m[2] === "in" ? n * 25.4 : m[2] === "pt" ? (n / 72) * 25.4 : null;
  };
  let w = len(attr("width"));
  let h = len(attr("height"));
  const vb = attr("viewBox")?.split(/[\s,]+/).map(Number);
  if ((w == null || h == null) && !vb && attr("width") && attr("height")) {
    // Pixels at 96 dpi.
    w = (Number(attr("width")!.replace(/px$/, "")) / 96) * 25.4;
    h = (Number(attr("height")!.replace(/px$/, "")) / 96) * 25.4;
  }
  if (!vb && attr("width") && attr("height")) s = s.replace(open, open.replace(/<svg/i, `<svg viewBox="0 0 ${parseFloat(attr("width")!)} ${parseFloat(attr("height")!)}"`));
  return { svg: s.trim(), wMm: w ?? null, hMm: h ?? null };
}
