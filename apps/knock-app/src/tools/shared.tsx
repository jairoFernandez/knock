import { useEffect, useMemo, useRef, useState } from "react";
import { highlightJson } from "../jsonHighlight";

const MAX_HISTORY = 20;

const PERSIST_EVENT = "knock-persist-change";

export function usePersistedField<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValueRaw] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    function onChange(e: Event) {
      const ce = e as CustomEvent<{ key: string; value: unknown }>;
      if (ce.detail?.key !== key) return;
      setValueRaw(ce.detail.value as T);
    }
    window.addEventListener(PERSIST_EVENT, onChange as EventListener);
    return () => window.removeEventListener(PERSIST_EVENT, onChange as EventListener);
  }, [key]);
  function setValue(v: T) {
    setValueRaw(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent(PERSIST_EVENT, { detail: { key, value: v } }),
    );
  }
  return [value, setValue];
}

export interface HistoryEntry {
  at: number;
  label: string;
  value: string;
}

export interface HistoryApi {
  entries: HistoryEntry[];
  push: (label: string, value: string) => void;
  clear: () => void;
  remove: (at: number) => void;
}

export function useHistory(key: string): HistoryApi {
  const [entries, setEntries] = usePersistedField<HistoryEntry[]>(key, []);
  function push(label: string, value: string) {
    if (!value) return;
    setEntries(
      [{ at: Date.now(), label, value }, ...entries.filter((e) => e.value !== value)].slice(
        0,
        MAX_HISTORY,
      ),
    );
  }
  function clear() {
    setEntries([]);
  }
  function remove(at: number) {
    setEntries(entries.filter((e) => e.at !== at));
  }
  return { entries, push, clear, remove };
}

export function HistoryList({
  history,
  onPick,
}: {
  history: HistoryApi;
  onPick: (value: string) => void;
}) {
  if (history.entries.length === 0) return null;
  return (
    <details className="tools-history">
      <summary>
        <span>History ({history.entries.length})</span>
        <button
          className="tools-copy"
          onClick={(e) => {
            e.preventDefault();
            history.clear();
          }}
          title="Clear history"
        >
          Clear
        </button>
      </summary>
      <ul className="tools-history-list">
        {history.entries.map((e) => (
          <li key={e.at} className="tools-history-item">
            <button
              className="tools-history-pick"
              onClick={() => onPick(e.value)}
              title={e.value}
            >
              <span className="tools-history-label">{e.label}</span>
              <span className="tools-history-value">{e.value.slice(0, 80)}</span>
              <span className="tools-history-time">{relTime(e.at)}</span>
            </button>
            <button
              className="tools-history-remove"
              onClick={() => history.remove(e.at)}
              title="Remove"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="tools-copy"
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      title="Copy to clipboard"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function CopyInline({ text }: { text: string }) {
  return (
    <button
      className="tools-copy-inline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* ignore */
        }
      }}
      title="Copy"
    >
      ⧉
    </button>
  );
}

export function relTime(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  const units: [number, string][] = [
    [1000 * 60 * 60 * 24 * 365, "y"],
    [1000 * 60 * 60 * 24 * 30, "mo"],
    [1000 * 60 * 60 * 24, "d"],
    [1000 * 60 * 60, "h"],
    [1000 * 60, "m"],
    [1000, "s"],
  ];
  for (const [size, label] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return past ? `${n}${label} ago` : `in ${n}${label}`;
    }
  }
  return "just now";
}

export function padBase64(s: string): string {
  const pad = s.length % 4;
  if (pad === 0) return s;
  return s + "=".repeat(4 - pad);
}

export function b64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function HighlightedJsonEditor({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const html = useMemo(() => highlightJson(value) + "\n", [value]);
  function syncScroll() {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }
  return (
    <div className={`tools-code-wrap ${className ?? ""}`}>
      <pre
        ref={preRef}
        className="tools-code-pre json-body"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        ref={taRef}
        className="tools-code-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
      />
    </div>
  );
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}
