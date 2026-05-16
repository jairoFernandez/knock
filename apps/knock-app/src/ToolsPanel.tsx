import { useEffect, useMemo, useRef, useState } from "react";
import { highlightJson } from "./jsonHighlight";

export type ToolKey = "base64" | "jwt" | "url" | "random" | "date";

interface Props {
  tool: ToolKey;
  onClose: () => void;
}

const TITLES: Record<ToolKey, string> = {
  base64: "Base64",
  jwt: "JWT",
  url: "URL encode",
  random: "Random",
  date: "Date",
};

const MAX_HISTORY = 20;

export function ToolsPanel({ tool, onClose }: Props) {
  return (
    <div className="panel tools-panel">
      <div className="panel-header tools-header">
        <span>{TITLES[tool]}</span>
        <button
          className="tools-close"
          onClick={onClose}
          title="Close panel"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="tools-body">
        {tool === "base64" && <Base64Tool />}
        {tool === "jwt" && <JwtTool />}
        {tool === "url" && <UrlTool />}
        {tool === "random" && <RandomTool />}
        {tool === "date" && <DateTool />}
      </div>
    </div>
  );
}

/* ---------- shared persistence ---------- */

function usePersistedField<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}

interface HistoryEntry {
  at: number;
  label: string;
  value: string;
}

function useHistory(key: string): {
  entries: HistoryEntry[];
  push: (label: string, value: string) => void;
  clear: () => void;
  remove: (at: number) => void;
} {
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

function HistoryList({
  history,
  onPick,
}: {
  history: ReturnType<typeof useHistory>;
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

/* ---------- Base64 ---------- */

function Base64Tool() {
  const [text, setText] = usePersistedField<string>("knock.tools.base64.input", "");
  const [mode, setMode] = usePersistedField<"encode" | "decode">(
    "knock.tools.base64.mode",
    "encode",
  );
  const history = useHistory("knock.tools.base64.history");

  const output = useMemo(() => {
    if (!text) return "";
    try {
      if (mode === "encode") {
        const bytes = new TextEncoder().encode(text);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      } else {
        const cleaned = text.replace(/\s+/g, "");
        const padded = padBase64(cleaned);
        const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      }
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }, [text, mode]);

  return (
    <>
      <div className="tools-tabs">
        <button className={mode === "encode" ? "active" : ""} onClick={() => setMode("encode")}>
          Encode
        </button>
        <button className={mode === "decode" ? "active" : ""} onClick={() => setMode("decode")}>
          Decode
        </button>
      </div>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => history.push(mode, text)}
        placeholder={mode === "encode" ? "Plain text" : "Base64 string"}
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      <textarea className="tools-textarea tools-output" value={output} readOnly spellCheck={false} />
      <HistoryList history={history} onPick={setText} />
    </>
  );
}

/* ---------- JWT ---------- */

const JWT_DATE_CLAIMS = ["exp", "iat", "nbf", "auth_time", "updated_at"] as const;

type JwtAlg = "HS256" | "HS384" | "HS512" | "none";

function JwtTool() {
  const [token, setToken] = usePersistedField<string>("knock.tools.jwt.input", "");
  const [headerText, setHeaderText] = usePersistedField<string>(
    "knock.tools.jwt.header",
    '{\n  "alg": "HS256",\n  "typ": "JWT"\n}',
  );
  const [payloadText, setPayloadText] = usePersistedField<string>(
    "knock.tools.jwt.payload",
    '{\n  "sub": "1234567890",\n  "name": "John Doe",\n  "iat": 1516239022\n}',
  );
  const [secret, setSecret] = usePersistedField<string>("knock.tools.jwt.secret", "your-256-bit-secret");
  const [secretIsBase64, setSecretIsBase64] = usePersistedField<boolean>(
    "knock.tools.jwt.secretB64",
    false,
  );
  const history = useHistory("knock.tools.jwt.history");

  const lastSyncRef = useRef<"token" | "parts">("token");

  // Decode token → parts (when token edited)
  const decoded = useMemo(() => {
    const t = token.trim();
    if (!t) return null;
    const parts = t.split(".");
    if (parts.length < 2) {
      return { error: "Not a JWT (needs at least 2 dot-separated segments)" };
    }
    try {
      const headerObj = decodeJwtSegmentObj(parts[0]);
      const payloadObj = decodeJwtSegmentObj(parts[1]);
      return {
        headerObj,
        payloadObj,
        header: JSON.stringify(headerObj, null, 2),
        payload: JSON.stringify(payloadObj, null, 2),
        signature: parts[2] ?? "",
      };
    } catch (e) {
      return { error: String(e) };
    }
  }, [token]);

  useEffect(() => {
    if (lastSyncRef.current !== "token") return;
    if (decoded && !("error" in decoded)) {
      setHeaderText(decoded.header);
      setPayloadText(decoded.payload);
    }
  }, [decoded]);

  const parseStatus: { headerErr?: string; payloadErr?: string; alg?: JwtAlg } = useMemo(() => {
    let headerErr: string | undefined;
    let payloadErr: string | undefined;
    let alg: JwtAlg | undefined;
    try {
      const h = JSON.parse(headerText);
      if (typeof h.alg === "string") alg = h.alg as JwtAlg;
    } catch (e) {
      headerErr = String(e);
    }
    try {
      JSON.parse(payloadText);
    } catch (e) {
      payloadErr = String(e);
    }
    return { headerErr, payloadErr, alg };
  }, [headerText, payloadText]);

  const payloadObj = useMemo(() => {
    try {
      return JSON.parse(payloadText) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [payloadText]);

  async function rebuildToken() {
    if (parseStatus.headerErr || parseStatus.payloadErr) return;
    try {
      const headerB64 = b64UrlEncode(headerText);
      const payloadB64 = b64UrlEncode(payloadText);
      const signingInput = `${headerB64}.${payloadB64}`;
      const alg = parseStatus.alg ?? "HS256";
      let sig = "";
      if (alg === "none") {
        sig = "";
      } else if (alg === "HS256" || alg === "HS384" || alg === "HS512") {
        sig = await hmacSign(signingInput, secret, secretIsBase64, alg);
      } else {
        // Unsupported (RS*/ES*/PS*) — leave existing signature if any
        sig = decoded && !("error" in (decoded ?? {})) ? (decoded as { signature: string }).signature : "";
      }
      const next = sig ? `${signingInput}.${sig}` : `${signingInput}.`;
      lastSyncRef.current = "parts";
      setToken(next);
      // Reset flag back so token edits re-sync parts
      setTimeout(() => {
        lastSyncRef.current = "token";
      }, 0);
    } catch (e) {
      console.error(e);
    }
  }

  // Auto-rebuild when parts change (debounced via effect)
  useEffect(() => {
    if (lastSyncRef.current !== "parts" && !headerText && !payloadText) return;
    if (parseStatus.headerErr || parseStatus.payloadErr) return;
    // Detect manual part edit: rebuild
    const id = setTimeout(() => {
      rebuildToken();
    }, 150);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerText, payloadText, secret, secretIsBase64]);

  const algSupported =
    parseStatus.alg === "HS256" ||
    parseStatus.alg === "HS384" ||
    parseStatus.alg === "HS512" ||
    parseStatus.alg === "none";

  return (
    <>
      <label className="tools-label">JWT (editable)</label>
      <ColorizedTokenView
        token={token}
        onChange={(v) => {
          lastSyncRef.current = "token";
          setToken(v);
        }}
        onBlur={() => history.push("jwt", token)}
      />
      {decoded && "error" in decoded && <div className="tools-error">{decoded.error}</div>}

      <div className="tools-output-header tools-section-header header-color">
        <span>Header {parseStatus.alg ? `· ${parseStatus.alg}` : ""}</span>
        <CopyButton text={headerText} />
      </div>
      <HighlightedJsonEditor
        value={headerText}
        onChange={(v) => {
          lastSyncRef.current = "parts";
          setHeaderText(v);
        }}
        className="jwt-header-editor"
      />
      {parseStatus.headerErr && <div className="tools-error">Header: {parseStatus.headerErr}</div>}

      <div className="tools-output-header tools-section-header payload-color">
        <span>Payload</span>
        <CopyButton text={payloadText} />
      </div>
      <HighlightedJsonEditor
        value={payloadText}
        onChange={(v) => {
          lastSyncRef.current = "parts";
          setPayloadText(v);
        }}
        className="jwt-payload-editor"
      />
      {parseStatus.payloadErr && (
        <div className="tools-error">Payload: {parseStatus.payloadErr}</div>
      )}

      {payloadObj && <JwtDates payload={payloadObj} onPatch={(patch) => {
        const next = { ...payloadObj, ...patch };
        lastSyncRef.current = "parts";
        setPayloadText(JSON.stringify(next, null, 2));
      }} />}

      <div className="tools-output-header">
        <span>Signature secret</span>
        <label className="tools-checkbox">
          <input
            type="checkbox"
            checked={secretIsBase64}
            onChange={(e) => setSecretIsBase64(e.target.checked)}
          />
          base64
        </label>
      </div>
      <input
        type="text"
        className="tools-input"
        value={secret}
        onChange={(e) => {
          lastSyncRef.current = "parts";
          setSecret(e.target.value);
        }}
        placeholder="HMAC secret"
        spellCheck={false}
      />

      {!algSupported && parseStatus.alg && (
        <div className="tools-warning">
          Algorithm <code>{parseStatus.alg}</code> not supported for signing here (RS/ES/PS need
          private keys). Existing signature preserved.
        </div>
      )}

      <HistoryList history={history} onPick={setToken} />
    </>
  );
}

function JwtDates({
  payload,
  onPatch,
}: {
  payload: Record<string, unknown>;
  onPatch?: (patch: Record<string, number>) => void;
}) {
  const rows: { claim: string; ts: number; expired?: boolean; future?: boolean }[] = [];
  const now = Date.now();
  for (const claim of JWT_DATE_CLAIMS) {
    const v = payload[claim];
    if (typeof v !== "number") continue;
    const ms = v * 1000;
    const row: { claim: string; ts: number; expired?: boolean; future?: boolean } = {
      claim,
      ts: ms,
    };
    if (claim === "exp") row.expired = ms < now;
    if (claim === "nbf") row.future = ms > now;
    rows.push(row);
  }
  if (rows.length === 0 && !onPatch) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    <div className="tools-dates">
      <div className="tools-label">Dates</div>
      {rows.map((r) => (
        <div
          key={r.claim}
          className={`tools-date-row ${r.expired ? "expired" : ""} ${r.future ? "future" : ""}`}
        >
          <span className="tools-date-claim">{r.claim}</span>
          <span className="tools-date-value">{new Date(r.ts).toLocaleString()}</span>
          <span className="tools-date-rel">{relTime(r.ts)}</span>
        </div>
      ))}
      {onPatch && (
        <div className="tools-date-actions">
          <button onClick={() => onPatch({ iat: nowSec })}>iat = now</button>
          <button onClick={() => onPatch({ exp: nowSec + 3600 })}>exp = +1h</button>
          <button onClick={() => onPatch({ exp: nowSec + 86400 })}>exp = +1d</button>
          <button onClick={() => onPatch({ nbf: nowSec })}>nbf = now</button>
        </div>
      )}
    </div>
  );
}

/* ---------- URL ---------- */

function UrlTool() {
  const [text, setText] = usePersistedField<string>("knock.tools.url.input", "");
  const [mode, setMode] = usePersistedField<"encode" | "decode">("knock.tools.url.mode", "encode");
  const history = useHistory("knock.tools.url.history");

  const output = useMemo(() => {
    if (!text) return "";
    try {
      return mode === "encode" ? encodeURIComponent(text) : decodeURIComponent(text);
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }, [text, mode]);

  return (
    <>
      <div className="tools-tabs">
        <button className={mode === "encode" ? "active" : ""} onClick={() => setMode("encode")}>
          Encode
        </button>
        <button className={mode === "decode" ? "active" : ""} onClick={() => setMode("decode")}>
          Decode
        </button>
      </div>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => history.push(mode, text)}
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      <textarea className="tools-textarea tools-output" value={output} readOnly spellCheck={false} />
      <HistoryList history={history} onPick={setText} />
    </>
  );
}

/* ---------- Random ---------- */

type RandomMode = "uuid" | "hex" | "base64" | "password";

function RandomTool() {
  const [mode, setMode] = usePersistedField<RandomMode>("knock.tools.random.mode", "uuid");
  const [length, setLength] = usePersistedField<number>("knock.tools.random.length", 32);
  const [output, setOutput] = usePersistedField<string>("knock.tools.random.output", "");
  const history = useHistory("knock.tools.random.history");

  function generate() {
    const v = genRandom(mode, length);
    setOutput(v);
    history.push(mode, v);
  }

  return (
    <>
      <div className="tools-tabs tools-tabs-wrap">
        {(["uuid", "hex", "base64", "password"] as RandomMode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      {mode !== "uuid" && (
        <div className="tools-row">
          <label className="tools-label" style={{ flex: 1 }}>
            Length
          </label>
          <input
            type="number"
            className="tools-input"
            min={1}
            max={1024}
            value={length}
            onChange={(e) => setLength(Math.max(1, Math.min(1024, Number(e.target.value) || 1)))}
          />
        </div>
      )}
      <button className="tools-generate" onClick={generate}>
        Generate
      </button>
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      <textarea
        className="tools-textarea tools-output"
        value={output}
        readOnly
        spellCheck={false}
      />
      <HistoryList history={history} onPick={setOutput} />
    </>
  );
}

function genRandom(mode: RandomMode, length: number): string {
  if (mode === "uuid") {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (mode === "hex") {
    const bytes = randomBytes(length);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (mode === "base64") {
    const bytes = randomBytes(length);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  // password — printable ASCII excluding ambiguous chars
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

/* ---------- Date ---------- */

function DateTool() {
  const [input, setInput] = usePersistedField<string>("knock.tools.date.input", "");
  const history = useHistory("knock.tools.date.history");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const parsed = useMemo(() => parseDate(input), [input]);
  const nowMs = Date.now();
  void tick;

  return (
    <>
      <div className="tools-row">
        <label className="tools-label" style={{ flex: 1 }}>
          Now
        </label>
        <button
          className="tools-copy"
          onClick={() => setInput(String(Math.floor(nowMs / 1000)))}
        >
          Use now
        </button>
      </div>
      <div className="tools-date-grid">
        <span>Epoch (s)</span>
        <span className="tools-mono">{Math.floor(nowMs / 1000)}</span>
        <span>Epoch (ms)</span>
        <span className="tools-mono">{nowMs}</span>
        <span>ISO 8601</span>
        <span className="tools-mono">{new Date(nowMs).toISOString()}</span>
      </div>
      <label className="tools-label">Input (epoch s/ms or any date string)</label>
      <input
        type="text"
        className="tools-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => history.push("date", input)}
        placeholder="1700000000 or 2026-05-16T12:00:00Z"
        spellCheck={false}
      />
      {input && parsed && (
        <div className="tools-date-grid">
          <span>Epoch (s)</span>
          <span className="tools-mono">
            {Math.floor(parsed.ms / 1000)}
            <CopyInline text={String(Math.floor(parsed.ms / 1000))} />
          </span>
          <span>Epoch (ms)</span>
          <span className="tools-mono">
            {parsed.ms}
            <CopyInline text={String(parsed.ms)} />
          </span>
          <span>ISO (UTC)</span>
          <span className="tools-mono">
            {new Date(parsed.ms).toISOString()}
            <CopyInline text={new Date(parsed.ms).toISOString()} />
          </span>
          <span>Local</span>
          <span className="tools-mono">{new Date(parsed.ms).toLocaleString()}</span>
          <span>UTC</span>
          <span className="tools-mono">{new Date(parsed.ms).toUTCString()}</span>
          <span>Relative</span>
          <span className="tools-mono">{relTime(parsed.ms)}</span>
        </div>
      )}
      {input && !parsed && <div className="tools-error">Could not parse date</div>}
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

function parseDate(s: string): { ms: number } | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    // Heuristic: > 10^12 → ms, else seconds
    const ms = n > 1e12 ? n : n * 1000;
    if (!Number.isFinite(ms)) return null;
    return { ms };
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  return { ms };
}

/* ---------- helpers ---------- */

function CopyButton({ text }: { text: string }) {
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

function CopyInline({ text }: { text: string }) {
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

function relTime(ms: number): string {
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

function padBase64(s: string): string {
  const pad = s.length % 4;
  if (pad === 0) return s;
  return s + "=".repeat(4 - pad);
}

function decodeJwtSegmentObj(seg: string): Record<string, unknown> {
  const padded = padBase64(seg).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

function b64UrlEncode(jsonText: string): string {
  // Re-stringify minified to match standard JWTs
  let canonical = jsonText;
  try {
    canonical = JSON.stringify(JSON.parse(jsonText));
  } catch {
    /* keep raw */
  }
  const bytes = new TextEncoder().encode(canonical);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function HighlightedJsonEditor({
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

function ColorizedTokenView({
  token,
  onChange,
  onBlur,
}: {
  token: string;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const html = useMemo(() => {
    if (!token) return "";
    const parts = token.split(".");
    const [h, p, s, ...rest] = parts;
    const segs: string[] = [];
    if (h !== undefined) segs.push(`<span class="jwt-h">${escapeHtml(h)}</span>`);
    if (p !== undefined) segs.push(`<span class="jwt-dot">.</span><span class="jwt-p">${escapeHtml(p)}</span>`);
    if (s !== undefined) segs.push(`<span class="jwt-dot">.</span><span class="jwt-s">${escapeHtml(s)}</span>`);
    for (const extra of rest) {
      segs.push(`<span class="jwt-dot">.</span><span class="jwt-s">${escapeHtml(extra)}</span>`);
    }
    return segs.join("") + "\n";
  }, [token]);
  function syncScroll() {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }
  return (
    <div className="tools-code-wrap jwt-token-wrap">
      <pre
        ref={preRef}
        className="tools-code-pre jwt-token-pre"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        ref={taRef}
        className="tools-code-input jwt-token-input"
        value={token}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onScroll={syncScroll}
        placeholder="eyJhbGciOi..."
        spellCheck={false}
      />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function hmacSign(
  data: string,
  secret: string,
  secretIsBase64: boolean,
  alg: "HS256" | "HS384" | "HS512",
): Promise<string> {
  const hash = { HS256: "SHA-256", HS384: "SHA-384", HS512: "SHA-512" }[alg];
  let keyBytes: Uint8Array;
  if (secretIsBase64) {
    const padded = padBase64(secret).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded);
    keyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  } else {
    keyBytes = new TextEncoder().encode(secret);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64UrlEncodeBytes(new Uint8Array(sig));
}
