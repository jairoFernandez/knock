import { useEffect, useMemo, useState } from "react";

import { HashTool } from "./tools/HashTool";
import { HmacTool } from "./tools/HmacTool";
import { JsonTool } from "./tools/JsonTool";
import { UrlParserTool } from "./tools/UrlParserTool";
import { RegexTool } from "./tools/RegexTool";
import { NumberBaseTool } from "./tools/NumberBaseTool";
import { HexAsciiTool } from "./tools/HexAsciiTool";
import { DiffTool } from "./tools/DiffTool";
import { CurlTool } from "./tools/CurlTool";
import { IpTool } from "./tools/IpTool";
import { CronTool } from "./tools/CronTool";
import { UserAgentTool } from "./tools/UserAgentTool";
import { MockDataTool } from "./tools/MockDataTool";
import { ColorTool } from "./tools/ColorTool";
import { UnitTool } from "./tools/UnitTool";
import { GraphqlTool } from "./tools/GraphqlTool";
import { JwkTool } from "./tools/JwkTool";
import { JwtTool } from "./tools/JwtTool";
import { KeyPairTool } from "./tools/KeyPairTool";
import { SecurityHeadersTool } from "./tools/SecurityHeadersTool";
import { SecretScanTool } from "./tools/SecretScanTool";
import { TotpTool } from "./tools/TotpTool";
import { PasswordTool } from "./tools/PasswordTool";
import { ToolsDashboard } from "./tools/ToolsDashboard";
import { TOOL_MAP, type ToolKey } from "./tools/registry";

export type { ToolKey } from "./tools/registry";

interface Props {
  tool: ToolKey;
  onClose: () => void;
  onNavigate: (next: ToolKey) => void;
}

const MAX_HISTORY = 20;

export function ToolsPanel({ tool, onClose, onNavigate }: Props) {
  const def = TOOL_MAP[tool];
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="panel tools-panel">
      <div className="panel-header tools-header">
        <span>{def?.title ?? tool}</span>
        <div className="tools-header-actions">
          {tool !== "dashboard" && (
            <button
              className="tools-close"
              onClick={() => setHelpOpen((v) => !v)}
              title="Help"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6 5.2c0-.8.6-1.4 1.3-1.4s1.2.5 1.2 1.2c0 1-1.5 1.1-1.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
                <circle cx="6.5" cy="9" r="0.6" fill="currentColor" />
              </svg>
            </button>
          )}
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
      </div>
      <div className="tools-body">
        {helpOpen && def && (
          <div className="tools-help">
            <strong>{def.title}</strong>
            <p>{def.description}</p>
          </div>
        )}
        {tool === "dashboard" && <ToolsDashboard onOpen={onNavigate} />}
        {tool === "base64" && <Base64Tool />}
        {tool === "jwt" && <JwtTool />}
        {tool === "url" && <UrlTool />}
        {tool === "random" && <RandomTool />}
        {tool === "date" && <DateTool />}
        {tool === "hash" && <HashTool />}
        {tool === "hmac" && <HmacTool />}
        {tool === "json" && <JsonTool />}
        {tool === "urlparse" && <UrlParserTool />}
        {tool === "regex" && <RegexTool />}
        {tool === "numbase" && <NumberBaseTool />}
        {tool === "hexascii" && <HexAsciiTool />}
        {tool === "diff" && <DiffTool />}
        {tool === "curl" && <CurlTool />}
        {tool === "ip" && <IpTool />}
        {tool === "cron" && <CronTool />}
        {tool === "ua" && <UserAgentTool />}
        {tool === "mock" && <MockDataTool />}
        {tool === "color" && <ColorTool />}
        {tool === "unit" && <UnitTool />}
        {tool === "gql" && <GraphqlTool />}
        {tool === "jwk" && <JwkTool />}
        {tool === "keypair" && <KeyPairTool />}
        {tool === "secheaders" && <SecurityHeadersTool />}
        {tool === "secrets" && <SecretScanTool />}
        {tool === "totp" && <TotpTool />}
        {tool === "password" && <PasswordTool />}
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

type RandomMode = "uuid" | "uuidv7" | "hex" | "base64" | "string";

interface CharOpts {
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  symbolSet: string;
  excludeAmbiguous: boolean;
  requireEach: boolean;
  extra: string;
}

const DEFAULT_SYMBOLS = "!@#$%^&*()-_=+[]{};:,.<>?/~";
const AMBIGUOUS = "0OoIl1|`'\"";

const DEFAULT_CHAR_OPTS: CharOpts = {
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  symbolSet: DEFAULT_SYMBOLS,
  excludeAmbiguous: true,
  requireEach: true,
  extra: "",
};

const STRING_PRESETS: { label: string; length: number; opts: Partial<CharOpts> }[] = [
  { label: "Password", length: 20, opts: { upper: true, lower: true, digits: true, symbols: true, requireEach: true } },
  { label: "Alphanumeric", length: 16, opts: { upper: true, lower: true, digits: true, symbols: false } },
  { label: "Letters", length: 12, opts: { upper: true, lower: true, digits: false, symbols: false } },
  { label: "PIN", length: 6, opts: { upper: false, lower: false, digits: true, symbols: false, excludeAmbiguous: false } },
  { label: "URL-safe token", length: 32, opts: { upper: true, lower: true, digits: true, symbols: true, symbolSet: "-_", excludeAmbiguous: false, requireEach: false } },
];

function RandomTool() {
  const [storedMode, setMode] = usePersistedField<RandomMode | "password">("knock.tools.random.mode", "uuid");
  const mode: RandomMode = storedMode === "password" ? "string" : storedMode;
  const [length, setLength] = usePersistedField<number>("knock.tools.random.length", 32);
  const [count, setCount] = usePersistedField<number>("knock.tools.random.count", 1);
  const [storedOpts, setOpts] = usePersistedField<CharOpts>("knock.tools.random.charOpts", DEFAULT_CHAR_OPTS);
  const opts: CharOpts = { ...DEFAULT_CHAR_OPTS, ...storedOpts };
  const [output, setOutput] = usePersistedField<string>("knock.tools.random.output", "");
  const [error, setError] = useState<string | null>(null);
  const history = useHistory("knock.tools.random.history");

  const setOpt = <K extends keyof CharOpts>(k: K, v: CharOpts[K]) => setOpts({ ...opts, [k]: v });
  const charset = mode === "string" ? buildCharset(opts) : null;

  function generate() {
    setError(null);
    try {
      const lines: string[] = [];
      for (let i = 0; i < count; i++) lines.push(genRandom(mode, length, opts));
      const v = lines.join("\n");
      setOutput(v);
      history.push(mode, v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="tools-tabs tools-tabs-wrap">
        {(["uuid", "uuidv7", "hex", "base64", "string"] as RandomMode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      {mode === "string" && (
        <div className="tools-tabs tools-tabs-wrap">
          {STRING_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setLength(p.length);
                setOpts({ ...DEFAULT_CHAR_OPTS, ...p.opts });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {mode !== "uuid" && mode !== "uuidv7" && (
        <div className="tools-row">
          <label className="tools-label" style={{ flex: 1 }}>
            {mode === "string" ? "Length (chars)" : "Length (bytes)"}
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
      {mode === "string" && (
        <>
          <div className="tools-row tools-row-wrap">
            <label className="tools-checkbox">
              <input type="checkbox" checked={opts.upper} onChange={(e) => setOpt("upper", e.target.checked)} />
              Uppercase (A-Z)
            </label>
            <label className="tools-checkbox">
              <input type="checkbox" checked={opts.lower} onChange={(e) => setOpt("lower", e.target.checked)} />
              Lowercase (a-z)
            </label>
            <label className="tools-checkbox">
              <input type="checkbox" checked={opts.digits} onChange={(e) => setOpt("digits", e.target.checked)} />
              Digits (0-9)
            </label>
            <label className="tools-checkbox">
              <input type="checkbox" checked={opts.symbols} onChange={(e) => setOpt("symbols", e.target.checked)} />
              Symbols
            </label>
          </div>
          {opts.symbols && (
            <div className="tools-row">
              <label className="tools-label" style={{ flex: 1 }}>
                Symbol set
              </label>
              <input
                type="text"
                className="tools-input"
                value={opts.symbolSet}
                onChange={(e) => setOpt("symbolSet", e.target.value)}
                spellCheck={false}
                style={{ fontFamily: "ui-monospace, monospace" }}
              />
              <button onClick={() => setOpt("symbolSet", DEFAULT_SYMBOLS)} title="Reset symbol set">
                ↺
              </button>
            </div>
          )}
          <div className="tools-row">
            <label className="tools-label" style={{ flex: 1 }}>
              Extra chars
            </label>
            <input
              type="text"
              className="tools-input"
              value={opts.extra}
              onChange={(e) => setOpt("extra", e.target.value)}
              placeholder="e.g. ñáé"
              spellCheck={false}
            />
          </div>
          <div className="tools-row tools-row-wrap">
            <label className="tools-checkbox" title={`Removes ${AMBIGUOUS}`}>
              <input
                type="checkbox"
                checked={opts.excludeAmbiguous}
                onChange={(e) => setOpt("excludeAmbiguous", e.target.checked)}
              />
              Exclude ambiguous (0 O l 1 I |)
            </label>
            <label className="tools-checkbox">
              <input
                type="checkbox"
                checked={opts.requireEach}
                onChange={(e) => setOpt("requireEach", e.target.checked)}
              />
              At least one of each selected type
            </label>
          </div>
          <div className="tools-hint">
            {charset && charset.all.length > 0
              ? `${charset.all.length} possible chars · ~${Math.floor(length * Math.log2(charset.all.length))} bits of entropy`
              : "Select at least one character type."}
          </div>
        </>
      )}
      <div className="tools-row">
        <label className="tools-label" style={{ flex: 1 }}>
          How many
        </label>
        <input
          type="number"
          className="tools-input"
          min={1}
          max={500}
          value={count}
          onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
        />
      </div>
      <button className="tools-generate" onClick={generate}>
        Generate
      </button>
      {error && <div className="tools-error">{error}</div>}
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

function buildCharset(o: CharOpts): { groups: string[]; all: string } {
  const strip = (s: string) => {
    const uniq = Array.from(new Set(Array.from(s)));
    return (o.excludeAmbiguous ? uniq.filter((c) => !AMBIGUOUS.includes(c)) : uniq).join("");
  };
  const groups = [
    o.upper ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "",
    o.lower ? "abcdefghijklmnopqrstuvwxyz" : "",
    o.digits ? "0123456789" : "",
    o.symbols ? o.symbolSet : "",
    o.extra,
  ]
    .map(strip)
    .filter(Boolean);
  return { groups, all: strip(groups.join("")) };
}

/** Uniform index in [0, n) — rejection sampling avoids modulo bias. */
function randomIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

function randomString(length: number, o: CharOpts): string {
  const { groups, all } = buildCharset(o);
  if (!all) throw new Error("Select at least one character type.");
  const chars = Array.from(all);
  const out: string[] = [];
  if (o.requireEach && length >= groups.length) {
    for (const g of groups) {
      const gc = Array.from(g);
      out.push(gc[randomIndex(gc.length)]);
    }
  }
  while (out.length < length) out.push(chars[randomIndex(chars.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

function genRandom(mode: RandomMode, length: number, opts: CharOpts): string {
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
  if (mode === "uuidv7") {
    const ms = Date.now();
    const bytes = randomBytes(16);
    // Time (48 bits big-endian)
    bytes[0] = (ms / 2 ** 40) & 0xff;
    bytes[1] = (ms / 2 ** 32) & 0xff;
    bytes[2] = (ms / 2 ** 24) & 0xff;
    bytes[3] = (ms / 2 ** 16) & 0xff;
    bytes[4] = (ms / 2 ** 8) & 0xff;
    bytes[5] = ms & 0xff;
    // Version 7
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    // Variant
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
  return randomString(length, opts);
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






