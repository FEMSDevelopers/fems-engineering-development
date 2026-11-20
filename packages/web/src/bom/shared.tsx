import { bomCtx, type BomCtx, type Part, type Subcategory } from "@fpl/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../api";

export interface Catalog {
  parts: Part[];
  subcats: Subcategory[];
  ctx: BomCtx;
  pmap: Map<string, Part>;
  smap: Map<string, Subcategory>;
  err: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Replace / add one part locally (after a save) without reloading everything. */
  putPart: (p: Part) => void;
}

/** Master parts + subcategories, loaded when the module is active. */
export function useCatalog(active: boolean): Catalog {
  const [parts, setParts] = useState<Part[]>([]);
  const [subcats, setSubcats] = useState<Subcategory[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.parts.list(), api.subcats.list()]);
      setParts(p);
      setSubcats(s);
      setErr(null);
      setLoaded(true);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  const putPart = useCallback((p: Part) => setParts((l) => (l.some((x) => x.id === p.id) ? l.map((x) => (x.id === p.id ? p : x)) : [...l, p])), []);
  const ctx = useMemo(() => bomCtx(parts, subcats), [parts, subcats]);
  return { parts, subcats, ctx, pmap: ctx.parts, smap: ctx.subcats!, err, loaded, refresh, putPart };
}

export const fmtN = (n: number | null | undefined, d = 1) => (n == null || !isFinite(n) ? "" : Number.isInteger(n) ? String(n) : n.toFixed(d));
export const partLabel = (p: Pick<Part, "manufacturer" | "partNumber"> | undefined) => (p ? `${p.manufacturer} ${p.partNumber}`.trim() : "");

/** Number input that commits on blur / Enter; empty = null. */
export function NumIn({ value, onChange, label, step, min, placeholder, width = 90 }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string; step?: number; min?: number; placeholder?: string; width?: number }) {
  const [v, setV] = useState(value == null ? "" : String(value));
  useEffect(() => setV(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const t = v.trim().replace(",", ".");
    const n = t === "" ? null : Number(t);
    if (n !== null && !isFinite(n)) return setV(value == null ? "" : String(value));
    if (n !== (value ?? null)) onChange(n);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={v}
      placeholder={placeholder}
      style={{ width }}
      data-step={step}
      data-min={min}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Text input that commits on blur / Enter. */
export function TextIn({ value, onChange, label, placeholder, mono, width, className }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; mono?: boolean; width?: number | string; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      type="text"
      aria-label={label}
      className={className}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      style={{ width, fontFamily: mono ? "var(--f-mono)" : undefined }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onChange(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Comma-separated list input (terminal labels, tags). */
export function ListIn({ value, onChange, label, placeholder, width }: { value: string[]; onChange: (v: string[]) => void; label: string; placeholder?: string; width?: number | string }) {
  return (
    <TextIn
      label={label}
      mono
      width={width}
      placeholder={placeholder}
      value={value.join(", ")}
      onChange={(t) => onChange(t.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean))}
    />
  );
}

export const STATUS_LABEL: Record<string, string> = { added: "Added", removed: "Removed", increased: "Increased", decreased: "Decreased", changed: "Changed", same: "Same" };
