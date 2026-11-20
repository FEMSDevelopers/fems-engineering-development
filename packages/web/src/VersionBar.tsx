import { bumpMajor, bumpMinor, latest, sameVer, stamp, verLabel, type Ver } from "@fpl/core";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { errMsg, type Versioned, type VersionedStore } from "./api";
import { LibraryBar, type MetaColumn } from "./editor/LibraryBar";
import { useLocal, useUi } from "./ui";

const V1: Ver = { major: 1, minor: 1 };
interface Lib {
  id: string | null;
  loaded: Ver | null;
  pending: Ver;
  /** Canonical hash of the data as last saved or loaded (to show unsaved changes). */
  savedHash: string | null;
}
const EMPTY: Lib = { id: null, loaded: null, pending: V1, savedHash: null };

const readLib = (key: string): Lib => {
  try {
    const s = localStorage.getItem(key);
    return s ? { ...EMPTY, ...JSON.parse(s) } : EMPTY;
  } catch {
    return EMPTY;
  }
};

/**
 * Save `data` as the next sub-version of the variant last used under `storageKey` (creating an "(auto)" variant if none),
 * without a mounted VersionBar. Used for automatic saves, e.g. after editing in Network details.
 */
export async function saveSubversionDirect<D>(o: {
  storageKey: string;
  store: VersionedStore;
  noun: string;
  data: D;
  canon: (d: D) => string;
  describe?: (d: D) => Record<string, unknown>;
  note?: string;
}): Promise<Ver> {
  const lib = readLib(o.storageKey);
  const items = await o.store.list();
  const cur = items.find((x) => x.id === lib.id);
  let id = cur?.id ?? null;
  const list = cur?.versions ?? [];
  const from = lib.loaded ?? latest(list) ?? null;
  const next = cur && from ? bumpMinor(from, list) : V1;
  if (!id) id = (await o.store.create({ name: `${o.noun[0].toUpperCase()}${o.noun.slice(1)} (auto) ${stamp()}` })).id;
  await o.store.saveVersion(id, next.major, next.minor, { stamp: stamp(), data: o.data, meta: o.describe?.(o.data) ?? {} });
  if (o.note) await o.store.notes(id, next.major, next.minor, { notes: o.note }).catch(() => {});
  try {
    localStorage.setItem(o.storageKey, JSON.stringify({ id, loaded: next, pending: next, savedHash: o.canon(o.data) }));
  } catch {
    /* ignore */
  }
  return next;
}

/** Which variant/version a VersionBar under `storageKey` last loaded or saved (null when detached). */
export function versionPointer(storageKey: string): { id: string | null; loaded: Ver | null } {
  const l = readLib(storageKey);
  return { id: l.id, loaded: l.loaded };
}

/**
 * Load a saved version without a mounted VersionBar (e.g. from a list in another tab) and make it the
 * current variant of `storageKey`. Asks first when `current` differs from the last save/load.
 * Returns false when the user cancelled.
 */
export async function loadVersionDirect<D>(o: {
  storageKey: string;
  store: VersionedStore;
  noun: string;
  id: string;
  ver: Ver;
  current: D | null;
  isEmpty?: (d: D) => boolean;
  canon: (d: D) => string;
  restore: (d: D) => void | Promise<void>;
  confirm: (msg: string, ok: string) => Promise<boolean>;
}): Promise<boolean> {
  const lib = readLib(o.storageKey);
  const dirty = !!o.current && !(o.isEmpty?.(o.current) ?? false) && o.canon(o.current) !== lib.savedHash;
  if (dirty && !(await o.confirm(`The current ${o.noun} differs from its last save. Load v${verLabel(o.ver)} and replace it?`, "Replace"))) return false;
  const ver = await o.store.getVersion(o.id, o.ver.major, o.ver.minor);
  await o.restore(ver.data as D);
  const v = { major: ver.major, minor: ver.minor };
  try {
    localStorage.setItem(o.storageKey, JSON.stringify({ id: o.id, loaded: v, pending: v, savedHash: o.canon(ver.data as D) }));
  } catch {
    /* ignore */
  }
  return true;
}

export interface VersionBarHandle {
  /** Save the current data as the next sub-version of the current variant (creates a variant if there is none). */
  saveSubversion: (note?: string, fresh?: unknown) => Promise<void>;
  /** Save the current data as a new variant (asks for its name; v1.001). */
  saveAsNew: () => Promise<void>;
  /** Load a saved version. Asks first when there are unsaved changes (always, unless `quiet`). */
  load: (id: string, v: Ver, quiet?: boolean) => Promise<void>;
}

/**
 * Save / version / sub-version / Recent controls for a whole dataset (e.g. the connection list or the network).
 * `data` is the live dataset; `canon` turns it into a stable string for change detection; `restore` writes a loaded version back.
 */
export function VersionBar<D>({
  storageKey, store, noun, data, canon, restore, describe, handle, defaultName, onItems, onCurrent, createExtra, metaColumn,
}: {
  storageKey: string;
  store: VersionedStore;
  noun: string;
  data: D | null;
  canon: (d: D) => string;
  /** Replace the live data with a saved version (and reload it). */
  restore: (d: D) => Promise<void>;
  /** Short summary saved as version metadata, e.g. { connections: 12 }. */
  describe?: (d: D) => Record<string, unknown>;
  handle?: Ref<VersionBarHandle>;
  /** Suggested name when the first save creates a new variant. */
  defaultName?: string;
  /** Called with the store's variants whenever the bar reloads them (after saves, renames, deletes). */
  onItems?: (items: Versioned[]) => void;
  /** Called when the current variant / loaded version changes. */
  onCurrent?: (id: string | null, loaded: Ver | null) => void;
  /** Extra fields for a new variant (e.g. the instance a conditioning belongs to). */
  createExtra?: Record<string, unknown>;
  /** A metadata value shown with each version and editable in Edit… (e.g. a project BOM's stage). */
  metaColumn?: MetaColumn;
}) {
  const ui = useUi();
  const [lib, setLib] = useLocal<Lib>(storageKey, EMPTY);
  const [items, setItems] = useState<Versioned[]>([]);
  const [busy, setBusy] = useState(false);
  const onItemsRef = useRef(onItems);
  onItemsRef.current = onItems;
  const refresh = useCallback(() => store.list().then((x) => (setItems(x), onItemsRef.current?.(x))).catch(() => {}), [store]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCurrentRef = useRef(onCurrent);
  onCurrentRef.current = onCurrent;
  const loadedKey = lib.loaded ? verLabel(lib.loaded) : "";
  useEffect(() => {
    onCurrentRef.current?.(lib.id, lib.loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.id, loadedKey, lib.savedHash]);
  const cur = items.find((x) => x.id === lib.id);
  const versions = cur?.versions ?? [];
  const hash = data ? canon(data) : null;
  const dirty = !!hash && hash !== lib.savedHash;
  const exists = !!cur && versions.some((v) => sameVer(v, lib.pending));

  const saveAs = async (v: Ver, id0: string | null, note?: string) => {
    if (!data) return;
    let id = id0;
    if (!id) {
      const name = note === undefined ? await ui.prompt(`Name for this ${noun}`, defaultName ?? `${noun[0].toUpperCase()}${noun.slice(1)} ${stamp()}`, "Save") : `${noun[0].toUpperCase()}${noun.slice(1)} (auto) ${stamp()}`;
      if (!name) return;
      id = (await store.create({ ...createExtra, name })).id;
    }
    const r = await store.saveVersion(id, v.major, v.minor, { stamp: stamp(), data, meta: describe?.(data) ?? {} });
    if (note) await store.notes(id, v.major, v.minor, { notes: note }).catch(() => {});
    setLib({ id, loaded: v, pending: v, savedHash: canon(data) });
    await refresh();
    ui.toast(`${r.created ? "Saved" : "Saved over"} ${noun} v${verLabel(v)}`);
  };
  const saveAsRef = useRef(saveAs);
  saveAsRef.current = saveAs;
  const save = async () => {
    setBusy(true);
    try {
      await saveAs(lib.pending, cur ? cur.id : null);
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  useImperativeHandle(handle, () => ({
    saveSubversion: async (note?: string, fresh?: unknown) => {
      const d = (fresh as D | undefined) ?? data;
      if (!d) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(lib));
      } catch {
        /* ignore */
      }
      const v = await saveSubversionDirect({ storageKey, store, noun, data: d, canon, describe, note });
      setLib(readLib(storageKey));
      await refresh();
      ui.toast(`Saved ${noun} v${verLabel(v)}`);
    },
    load: (id: string, v: Ver, quiet?: boolean) => loadRef.current(id, v, quiet),
    saveAsNew: async () => {
      setBusy(true);
      try {
        await saveAsRef.current(V1, null);
      } catch (e) {
        ui.toast(`Couldn’t save: ${errMsg(e)}`);
      } finally {
        setBusy(false);
      }
    },
  }));

  const loadRef = useRef<(id: string, v: Ver, quiet?: boolean) => Promise<void>>(async () => {});
  const load = async (id: string, v: Ver, quiet = false) => {
    if (dirty && !(await ui.confirm(`The current ${noun} differs from the last save. Load v${verLabel(v)} and replace it?`, "Replace"))) return;
    if (!dirty && !quiet && !(await ui.confirm(`Load v${verLabel(v)}? This replaces the current ${noun}.`, "Load"))) return;
    setBusy(true);
    try {
      const ver = await store.getVersion(id, v.major, v.minor);
      await restore(ver.data as D);
      setLib({ id, loaded: { major: ver.major, minor: ver.minor }, pending: { major: ver.major, minor: ver.minor }, savedHash: canon(ver.data as D) });
      ui.toast(`Loaded ${noun} v${verLabel(ver)}`);
    } catch (e) {
      ui.toast(`Couldn’t load: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  loadRef.current = load;

  return (
    <div className="verbar">
      <div className="savegrp">
        <button
          type="button"
          className="save btn-primary"
          disabled={busy || !data}
          onClick={save}
          title={(dirty ? "Unsaved changes. " : "") + (exists ? `Overwrites v${verLabel(lib.pending)}` : `Creates v${verLabel(lib.pending)}`)}
        >
          {dirty && <span className="dot" />}
          {(exists ? "Save v" : cur ? "Save as v" : "Save new v") + verLabel(lib.pending)}
        </button>
        <div className="bump">
          <button type="button" title="Next sub-version" onClick={() => setLib({ ...lib, pending: bumpMinor(lib.pending, versions) })}>+.001</button>
          <button type="button" title="Next version" onClick={() => setLib({ ...lib, pending: bumpMajor(lib.pending, versions) })}>+1.</button>
        </div>
        <button
          type="button"
          className="btn-ghost cancelch"
          disabled={busy || !dirty || !lib.id || !lib.loaded}
          title={!lib.loaded ? "Nothing saved yet to go back to" : dirty ? `Discard the changes and go back to v${verLabel(lib.loaded)}` : "No unsaved changes"}
          onClick={async () => {
            if (!lib.id || !lib.loaded) return;
            if (!(await ui.confirm(`Discard the unsaved changes and go back to the saved v${verLabel(lib.loaded)}?`, "Discard changes"))) return;
            setBusy(true);
            try {
              const ver = await store.getVersion(lib.id, lib.loaded.major, lib.loaded.minor);
              await restore(ver.data as D);
              setLib({ ...lib, savedHash: canon(ver.data as D) });
              ui.toast(`Changes discarded — back to v${verLabel(lib.loaded)}`);
            } catch (e) {
              ui.toast(`Couldn’t reload: ${errMsg(e)}`);
            } finally {
              setBusy(false);
            }
          }}
        >Cancel changes</button>
      </div>
      <LibraryBar
        store={store}
        noun={noun}
        profiles={items}
        profileId={lib.id}
        loaded={lib.loaded}
        recentAll
        metaColumn={metaColumn}
        onPickProfile={async (id) => {
          if (!id) {
            setLib({ ...EMPTY });
            return ui.toast(`Next save creates a new ${noun}`);
          }
          const v = latest(items.find((x) => x.id === id)?.versions ?? []);
          if (v) await load(id, v);
        }}
        onLoad={load}
        onChanged={refresh}
        onDetach={() => setLib({ ...EMPTY })}
      />
    </div>
  );
}
