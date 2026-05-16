import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfirmOptions } from "./ConfirmDialog";

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function useConfirm(): {
  pending: PendingConfirm | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  resolve: (ok: boolean) => void;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);
  const resolve = useCallback(
    (ok: boolean) => {
      setPending((cur) => {
        if (cur) cur.resolve(ok);
        return null;
      });
    },
    [],
  );
  return { pending, confirm, resolve };
}


export function usePersistedNumber(key: string, initial: number): [number, (v: number) => void] {
  const [value, setValue] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const n = Number(raw);
      return Number.isFinite(n) ? n : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}

export function usePersistedString<T extends string>(
  key: string,
  initial: T | null,
): [T | null, (v: T | null) => void] {
  const [value, setValue] = useState<T | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === "") return initial;
      return raw as T;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}

interface DragOptions {
  axis?: "x" | "y";
  onDelta: (deltaPx: number) => void;
}

export function useColumnDrag({ onDelta, axis = "x" }: DragOptions) {
  const startRef = useRef<number | null>(null);
  const onDeltaRef = useRef(onDelta);
  onDeltaRef.current = onDelta;

  function start(e: React.MouseEvent) {
    e.preventDefault();
    startRef.current = axis === "x" ? e.clientX : e.clientY;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      if (startRef.current === null) return;
      const pos = axis === "x" ? ev.clientX : ev.clientY;
      const delta = pos - startRef.current;
      startRef.current = pos;
      onDeltaRef.current(delta);
    }
    function onUp() {
      startRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  return start;
}
