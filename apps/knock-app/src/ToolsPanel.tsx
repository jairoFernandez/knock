import { useMemo, useState } from "react";

export type ToolKey = "base64" | "jwt" | "url";

interface Props {
  tool: ToolKey;
  onClose: () => void;
}

const TITLES: Record<ToolKey, string> = {
  base64: "Base64",
  jwt: "JWT",
  url: "URL encode",
};

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
      </div>
    </div>
  );
}

function Base64Tool() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"encode" | "decode">("encode");

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
        <button
          className={mode === "encode" ? "active" : ""}
          onClick={() => setMode("encode")}
        >
          Encode
        </button>
        <button
          className={mode === "decode" ? "active" : ""}
          onClick={() => setMode("decode")}
        >
          Decode
        </button>
      </div>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={mode === "encode" ? "Plain text" : "Base64 string"}
        spellCheck={false}
      />
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
    </>
  );
}

function JwtTool() {
  const [token, setToken] = useState("");

  const parsed = useMemo(() => {
    const t = token.trim();
    if (!t) return null;
    const parts = t.split(".");
    if (parts.length < 2) {
      return { error: "Not a JWT (needs at least 2 dot-separated segments)" };
    }
    try {
      const header = decodeJwtSegment(parts[0]);
      const payload = decodeJwtSegment(parts[1]);
      const signature = parts[2] ?? "";
      return { header, payload, signature };
    } catch (e) {
      return { error: String(e) };
    }
  }, [token]);

  return (
    <>
      <label className="tools-label">JWT</label>
      <textarea
        className="tools-textarea"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="eyJhbGciOi..."
        spellCheck={false}
      />
      {parsed && "error" in parsed && (
        <div className="tools-error">{parsed.error}</div>
      )}
      {parsed && !("error" in parsed) && (
        <>
          <div className="tools-output-header">
            <span>Header</span>
            <CopyButton text={parsed.header} />
          </div>
          <pre className="tools-pre">{parsed.header}</pre>
          <div className="tools-output-header">
            <span>Payload</span>
            <CopyButton text={parsed.payload} />
          </div>
          <pre className="tools-pre">{parsed.payload}</pre>
          {parsed.payload && <ExpiryHint payload={parsed.payload} />}
          <div className="tools-output-header">
            <span>Signature</span>
          </div>
          <pre className="tools-pre tools-signature">{parsed.signature || "(none)"}</pre>
        </>
      )}
    </>
  );
}

function UrlTool() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"encode" | "decode">("encode");

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
        <button
          className={mode === "encode" ? "active" : ""}
          onClick={() => setMode("encode")}
        >
          Encode
        </button>
        <button
          className={mode === "decode" ? "active" : ""}
          onClick={() => setMode("decode")}
        >
          Decode
        </button>
      </div>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
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
    </>
  );
}

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

function ExpiryHint({ payload }: { payload: string }) {
  try {
    const obj = JSON.parse(payload);
    const exp = typeof obj.exp === "number" ? obj.exp : null;
    if (exp === null) return null;
    const expMs = exp * 1000;
    const now = Date.now();
    const expired = expMs < now;
    const date = new Date(expMs).toLocaleString();
    return (
      <div className={`tools-expiry ${expired ? "expired" : "valid"}`}>
        {expired ? "Expired" : "Expires"} {date}
      </div>
    );
  } catch {
    return null;
  }
}

function padBase64(s: string): string {
  const pad = s.length % 4;
  if (pad === 0) return s;
  return s + "=".repeat(4 - pad);
}

function decodeJwtSegment(seg: string): string {
  const padded = padBase64(seg).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
