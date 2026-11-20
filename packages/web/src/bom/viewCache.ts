import type { PartView, ViewName } from "@fpl/core";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

/** data: URL for an <img> / <image> showing a stored view. */
export const viewSrc = (v: Pick<PartView, "kind" | "content">) => (v.kind === "image" ? v.content : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.content)}`);


type ViewMap = Map<string, Partial<Record<ViewName, PartView>>>;
const cache: ViewMap = new Map();
const listeners = new Set<() => void>();
/** Forget cached views of a part (after an upload or STEP import) so drawings reload them. */
export function invalidateViews(partId?: string) {
  if (partId) cache.delete(partId);
  else cache.clear();
  listeners.forEach((f) => f());
}
/** 2D views of the given parts, keyed by part id. */
export function useViews(partIds: string[]): { views: ViewMap; refresh: () => void } {
  const key = [...new Set(partIds)].sort().join(",");
  const [tick, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  useEffect(() => {
    const missing = (key ? key.split(",") : []).filter((id) => !cache.has(id));
    if (!missing.length) return;
    let live = true;
    (async () => {
      // In batches (URL length).
      for (let i = 0; i < missing.length; i += 150) {
        const chunk = missing.slice(i, i + 150);
        const list = await api.views.list(chunk).catch(() => [] as PartView[]);
        for (const id of chunk) cache.set(id, {});
        for (const v of list) cache.get(v.partId)![v.view] = v;
      }
      if (live) bump((n) => n + 1);
    })();
    return () => {
      live = false;
    };
  }, [key, tick]);
  return { views: cache, refresh: useCallback(() => invalidateViews(), []) };
}
