import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { storageWritable } from "./project";
import type { Line, Seg } from "@fpl/core";

// ---------- toast + confirm ----------
interface UiCtx {
  toast: (msg: string) => void;
  confirm: (msg: string, yes?: string) => Promise<boolean>;
  prompt: (label: string, def: string, yes?: string) => Promise<string | null>;
}
const Ctx = createContext<UiCtx>({ toast: () => {}, confirm: async () => false, prompt: async () => null });
export const useUi = () => useContext(Ctx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const [dlg, setDlg] = useState<
    | { kind: "confirm"; msg: string; yes: string; done: (v: boolean) => void }
    | { kind: "prompt"; msg: string; yes: string; value: string; done: (v: string | null) => void }
    | null
  >(null);
  const toast = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 1800);
  }, []);
  const confirm = useCallback((m: string, yes = "Continue") => new Promise<boolean>((done) => setDlg({ kind: "confirm", msg: m, yes, done })), []);
  const prompt = useCallback((m: string, def: string, yes = "Save") => new Promise<string | null>((done) => setDlg({ kind: "prompt", msg: m, yes, value: def, done })), []);
  const close = (v: boolean) => {
    if (!dlg) return;
    if (dlg.kind === "confirm") dlg.done(v);
    else dlg.done(v ? dlg.value.trim() || null : null);
    setDlg(null);
  };
  return (
    <Ctx.Provider value={{ toast, confirm, prompt }}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
      {dlg && (
        <Modal size="sm" onClose={() => close(false)}>
          <div className="mb">
            {dlg.kind === "confirm" ? (
              <p style={{ margin: 0 }}>{dlg.msg}</p>
            ) : (
              <label className="f">
                {dlg.msg}
                <input
                  type="text"
                  autoFocus
                  value={dlg.value}
                  onChange={(e) => setDlg({ ...dlg, value: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && close(true)}
                />
              </label>
            )}
          </div>
          <div className="mf">
            <button type="button" onClick={() => close(false)}>Cancel</button>
            <button type="button" className="btn-primary" autoFocus={dlg.kind === "confirm"} onClick={() => close(true)}>{dlg.yes}</button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export function Modal({ children, onClose, size, label }: { children: ReactNode; onClose: () => void; size?: "sm"; label?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${size ? " " + size : ""}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** Small popover anchored to a button; closes on outside click or Escape. */
export function Popover({ button, children, align = "left", label }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const c = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", c);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", c);
      document.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <div className="popwrap" ref={ref}>
      <button type="button" className="popbtn" aria-haspopup="true" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {button}
      </button>
      {open && <div className={`pop ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

export const SegSpan = ({ s }: { s: Seg }) => (s.t === "w" ? <>{s.v}</> : <span className={`t-${s.t}`}>{s.v}</span>);
export const LineView = ({
  line, className, ref, ...rest
}: { line: Line; className?: string; ref?: React.Ref<HTMLSpanElement>; "data-col"?: number } & React.HTMLAttributes<HTMLSpanElement>) => (
  <span ref={ref} className={`ln${className ? " " + className : ""}`} {...rest}>
    {line.segs.length ? line.segs.map((s, i) => <SegSpan key={i} s={s} />) : " "}
  </span>
);

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function useLocal<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      if (!s) return init;
      const parsed = JSON.parse(s);
      // Objects are merged over the defaults (new fields get their default); other values are used as stored.
      const isObj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
      return isObj(init) && isObj(parsed) ? { ...init, ...parsed } : isObj(init) || typeof parsed !== typeof init ? init : parsed;
    } catch {
      return init;
    }
  });
  useEffect(() => {
    try {
      if (storageWritable(key)) localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage full or blocked: keep working in memory */
    }
  }, [key, v]);
  return [v, setV];
}

/** Drag the divider of a .split container to resize the left pane. */
export function Gutter({ target }: { target: React.RefObject<HTMLElement | null> }) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`gutter${drag ? " drag" : ""}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        const el = target.current;
        if (!el) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(true);
        const box = el.getBoundingClientRect();
        const move = (ev: PointerEvent) => el.style.setProperty("--split", Math.min(80, Math.max(20, ((ev.clientX - box.left) / box.width) * 100)) + "%");
        const up = () => {
          setDrag(false);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

export const ICONS = {
  mech: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="1.5" /><path d="M3 8h18M3 16h18" /><rect x="6" y="10" width="4" height="4" /><rect x="11" y="10" width="2" height="4" /><rect x="14" y="10" width="2" height="4" /><circle cx="8" cy="19" r="1" /><circle cx="12" cy="19" r="1" />
    </svg>
  ),
  bom: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="2" width="14" height="20" rx="1.5" /><path d="M5 7h14M5 12h14M5 17h14" /><circle cx="8" cy="9.5" r=".6" /><circle cx="8" cy="14.5" r=".6" /><path d="M11 9.5h5M11 14.5h5" />
    </svg>
  ),
  sources: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  ),
  editor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
    </svg>
  ),
  json: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3H5a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" /><circle cx="10" cy="7" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="15" cy="18" r="1.6" />
      <path d="M10 8.6V18h3.4M10 12h3.4" /><path d="M19 7h3M19 12h3M19 18h3" />
    </svg>
  ),
  network: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="5" rx="1" /><rect x="2" y="17" width="6" height="5" rx="1" /><rect x="16" y="17" width="6" height="5" rx="1" /><path d="M12 7v5M5 17v-3h14v3" />
    </svg>
  ),
  dataflow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="7" height="5" rx="1" /><rect x="15" y="16" width="7" height="5" rx="1" /><rect x="15" y="3" width="7" height="5" rx="1" />
      <path d="M9 5.5h6M5.5 8v7a3 3 0 0 0 3 3H15" /><path d="M12.5 3.5 15 5.5l-2.5 2M12.5 16l2.5 2.5-2.5 2" />
    </svg>
  ),
  outputs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 18v-6M9 15l3 3 3-3" />
    </svg>
  ),
};

/** Colour input that commits once the picker closes (native "change"), not on every drag of the picker. */
export function ColorPick({ value, onCommit, label, title }: { value: string; onCommit: (v: string) => void; label: string; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(value);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => commit.current(el.value);
    el.addEventListener("change", h);
    return () => el.removeEventListener("change", h);
  }, []);
  return <input ref={ref} type="color" className="cpick" aria-label={label} title={title} value={v} onChange={(e) => setV(e.target.value)} />;
}

/** Button that fires only after being held down for `ms` (shows a fill while held). Used for destructive one-click actions. */
/**
 * Click-and-hold on any element (e.g. a text field): `fn` runs after `ms` of holding still. Moving the pointer (selecting
 * text) or releasing earlier cancels it, so normal typing and clicking are unaffected.
 */
export function useHold(ms: number, fn: () => void) {
  const t = useRef<number>(0);
  const at = useRef<{ x: number; y: number } | null>(null);
  const [holding, setHolding] = useState(false);
  const stop = () => {
    window.clearTimeout(t.current);
    at.current = null;
    setHolding(false);
  };
  useEffect(() => () => window.clearTimeout(t.current), []);
  return {
    "data-holding": holding ? "1" : undefined,
    style: { ["--hold-ms" as string]: `${ms}ms` },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      at.current = { x: e.clientX, y: e.clientY };
      setHolding(true);
      window.clearTimeout(t.current);
      t.current = window.setTimeout(() => {
        stop();
        fn();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (at.current && Math.hypot(e.clientX - at.current.x, e.clientY - at.current.y) > 5) stop();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
  };
}

export function HoldButton({ ms = 400, onHold, label, children, className, disabled, title }: { ms?: number; onHold: () => void; label: string; children: ReactNode; className?: string; disabled?: boolean; /** Tooltip (default: label + hold time). */ title?: string }) {
  const t = useRef<number>(0);
  const [holding, setHolding] = useState(false);
  const stop = () => {
    window.clearTimeout(t.current);
    setHolding(false);
  };
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <button
      type="button"
      className={["holdbtn", holding && "holding", className].filter(Boolean).join(" ")}
      style={{ ["--hold-ms" as string]: `${ms}ms` }}
      aria-label={label}
      title={title ?? `${label} (hold ${ms / 1000}s)`}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (disabled) return;
        setHolding(true);
        t.current = window.setTimeout(() => {
          setHolding(false);
          onHold();
        }, ms);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        // Keyboard: Delete key on the focused button confirms.
        if (e.key === "Delete" && !disabled) (e.stopPropagation(), onHold());
      }}
    >
      {children}
    </button>
  );
}
