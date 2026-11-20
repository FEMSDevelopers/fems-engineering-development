export interface Ver {
  major: number;
  minor: number;
}

/** 1.001, 232.933 */
export const verLabel = (v: Ver) => `${v.major}.${String(v.minor).padStart(3, "0")}`;
export const sameVer = (a: Ver | null | undefined, b: Ver | null | undefined) => !!a && !!b && a.major === b.major && a.minor === b.minor;

/** Next sub-version: 1.001 → 1.002, skipping numbers already used. */
export function bumpMinor(v: Ver, existing: Ver[]): Ver {
  let { major, minor } = v;
  do minor++;
  while (existing.some((e) => e.major === major && e.minor === minor));
  return { major, minor };
}

/** Next version: 232.933 → 233.001, skipping majors already used. */
export function bumpMajor(v: Ver, existing: Ver[]): Ver {
  let { major } = v;
  do major++;
  while (existing.some((e) => e.major === major));
  return { major, minor: 1 };
}

export const latest = <T extends Ver>(vs: T[]): T | undefined => vs.slice().sort((a, b) => b.major - a.major || b.minor - a.minor)[0];

const p2 = (n: number) => String(n).padStart(2, "0");
/** Generic save stamp YYMMDD_HHMMSS_sss (local time). */
export function stamp(d = new Date()): string {
  return `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3, "0")}`;
}
/** 2026-10-16 14:03:22 (local time) */
export function fmtDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
