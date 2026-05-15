import { useEffect, useRef, useState } from "react";

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
