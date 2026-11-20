import { latest, type Ver } from "@fpl/core";
import { useEffect, useRef, useState } from "react";
import type { Versioned, VersionedStore } from "../api";

/** Saved versions of a store, loaded on demand and cached by id@version. */
export function useVersionData<T>(store: VersionedStore, refs: { id: string | null; ver: Ver | null }[], items: Versioned[]) {
  const cache = useRef(new Map<string, T>());
  const [, bump] = useState(0);
  const resolved = refs.map((r) => {
    const it = items.find((x) => x.id === r.id);
    const v = r.ver ?? (it ? latest(it.versions) ?? null : null);
    return { id: it ? r.id : null, v, key: it && v ? `${r.id}@${v.major}.${v.minor}` : "" };
  });
  const want = resolved.map((r) => r.key).join("|");
  useEffect(() => {
    let live = true;
    for (const r of resolved) {
      if (!r.key || cache.current.has(r.key)) continue;
      store.getVersion(r.id!, r.v!.major, r.v!.minor).then((x) => {
        cache.current.set(r.key, x.data as T);
        if (live) bump((n) => n + 1);
      }).catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);
  return resolved.map((r) => ({ ...r, data: r.key ? cache.current.get(r.key) ?? null : null }));
}

