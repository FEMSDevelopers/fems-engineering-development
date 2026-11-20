import type { DashKind, HeadKind, ProtocolDef, ProtocolStyle } from "@fpl/core";

export const HEADS: [HeadKind, string][] = [["none", "None"], ["arrow", "Arrow"], ["open", "Open arrow"], ["dot", "Dot"], ["diamond", "Diamond"]];
export const DASHES: [DashKind, string][] = [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["dashdot", "Dash-dot"]];

export const strokeWidth = (s: ProtocolStyle) => s.width * s.scale;
export const headSize = (s: ProtocolStyle) => (7 + s.width * 2.2) * s.scale;

export function dashArray(s: ProtocolStyle): string | undefined {
  const w = strokeWidth(s);
  if (s.dash === "dashed") return `${6 * w} ${4 * w}`;
  if (s.dash === "dotted") return `${0.01} ${2.6 * w}`;
  if (s.dash === "dashdot") return `${8 * w} ${3 * w} ${0.01} ${3 * w}`;
  return undefined;
}

export const markerId = (prefix: string, protoId: string, head: HeadKind) => `${prefix}-${protoId}-${head}`;

function HeadShape({ head, color, sw }: { head: HeadKind; color: string; sw: number }) {
  if (head === "arrow") return <path d="M0,0 L10,5 L0,10 z" fill={color} />;
  if (head === "open") return <path d="M1,1 L9,5 L1,9" fill="none" stroke={color} strokeWidth={Math.max(1.2, sw)} strokeLinejoin="round" />;
  if (head === "dot") return <circle cx="5" cy="5" r="4" fill={color} />;
  if (head === "diamond") return <path d="M0,5 L5,0 L10,5 L5,10 z" fill={color} />;
  return null;
}

/** <marker> definitions for every protocol × head kind in use. Markers use user-space units so they don't grow with stroke width twice. */
export function MarkerDefs({ protocols, prefix }: { protocols: ProtocolDef[]; prefix: string }) {
  return (
    <defs>
      {protocols.flatMap((p) => {
        const s = p.style;
        const size = headSize(s);
        return (["arrow", "open", "dot", "diamond"] as HeadKind[]).map((h) => (
          <marker
            key={h}
            id={markerId(prefix, p.id, h)}
            viewBox="0 0 10 10"
            refX={h === "dot" || h === "diamond" ? 5 : 9.5}
            refY="5"
            markerWidth={size}
            markerHeight={size}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <HeadShape head={h} color={s.color} sw={10 / size} />
          </marker>
        ));
      })}
    </defs>
  );
}

/** A short sample of a protocol's line, for the editor and legend. */
export function LinePreview({ p, width = 120 }: { p: ProtocolDef; width?: number }) {
  const s = p.style;
  const prefix = `pv${p.id.replace(/[^\w-]/g, "")}`;
  const sw = strokeWidth(s);
  const pad = headSize(s) / 2 + 2;
  return (
    <svg width={width} height={28} viewBox={`0 0 ${width} 28`} aria-hidden="true" style={{ display: "block" }}>
      <MarkerDefs protocols={[p]} prefix={prefix} />
      <line
        x1={pad}
        y1={14}
        x2={width - pad}
        y2={14}
        stroke={s.color}
        strokeWidth={sw}
        strokeOpacity={s.opacity}
        strokeDasharray={dashArray(s)}
        strokeLinecap={s.dash === "dotted" || s.dash === "dashdot" ? "round" : "butt"}
        markerStart={s.startHead !== "none" ? `url(#${markerId(prefix, p.id, s.startHead)})` : undefined}
        markerEnd={s.endHead !== "none" ? `url(#${markerId(prefix, p.id, s.endHead)})` : undefined}
      />
    </svg>
  );
}

/** Default port shown as a placeholder. Not inherited: e.g. Modbus Serial has no TCP port even though Modbus does. */
export function defaultPortOf(p: ProtocolDef | undefined, _protocols: ProtocolDef[]): string {
  return p?.defaultPort ?? "";
}

/** Protocols in display order: parents followed by their children. */
export function orderedProtocols(protocols: ProtocolDef[]): (ProtocolDef & { depth: number })[] {
  const out: (ProtocolDef & { depth: number })[] = [];
  const sorted = protocols.slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const walk = (parent: string | null, depth: number) => {
    for (const p of sorted.filter((x) => (x.parentId ?? null) === parent && !out.some((o) => o.id === x.id))) {
      out.push({ ...p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const p of sorted) if (!out.some((o) => o.id === p.id)) out.push({ ...p, depth: 0 }); // orphans (parent deleted)
  return out;
}
