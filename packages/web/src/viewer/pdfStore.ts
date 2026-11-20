/**
 * Hand-over of a PDF to the full-window viewer tab: documents stored on the server open by URL; a PDF held in memory
 * (e.g. the datasheet read by Fill from OEM page) is put in IndexedDB (shared by the tabs of this site) under a key.
 */
export type PageMarks = Record<number, number[][]>;
interface Entry { data: Uint8Array; title: string; marks?: PageMarks; at: number }
const DB = "fpl-viewer";
const STORE = "pdf";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const q = f(t.objectStore(STORE));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
export async function putPdf(e: Omit<Entry, "at">): Promise<string> {
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // Old hand-overs (a day) are dropped.
  try {
    const keys = (await tx("readonly", (s) => s.getAllKeys())) as string[];
    for (const k of keys) {
      const v = (await tx("readonly", (s) => s.get(k))) as Entry | undefined;
      if (!v || Date.now() - v.at > 86400000) await tx("readwrite", (s) => s.delete(k));
    }
  } catch {
    /* ignore */
  }
  await tx("readwrite", (s) => s.put({ ...e, at: Date.now() }, key));
  return key;
}
export const getPdf = (key: string) => tx("readonly", (s) => s.get(key)) as Promise<Entry | undefined>;

/** Opens the full-window viewer in a new tab: a stored document (by id) or a PDF held in memory. */
export async function openPdfViewer(o: { docId?: string; data?: Uint8Array; title: string; page?: number; marks?: PageMarks; view?: { zoom: number; zmode: "global" | "highlight"; span: number } }) {
  const p = new URLSearchParams({ viewer: "pdf", title: o.title, page: String(o.page ?? 1) });
  // The preview's view (zoom relative to its fit, global / highlighted, pages shown) — "Preview view" in the viewer.
  if (o.view) (p.set("pz", String(o.view.zoom)), p.set("pm", o.view.zmode), p.set("ps", String(o.view.span)));
  // The tab is opened at once (pop-up blockers allow it only in the click), then pointed at the viewer.
  const w = window.open("about:blank", "_blank");
  if (o.docId) p.set("doc", o.docId);
  else if (o.data) p.set("key", await putPdf({ data: o.data, title: o.title, marks: o.marks }));
  if (o.marks && o.docId) p.set("marks", JSON.stringify(o.marks));
  const url = `${location.origin}${location.pathname}?${p}`;
  if (w) w.location.href = url;
  else window.open(url, "_blank");
}
