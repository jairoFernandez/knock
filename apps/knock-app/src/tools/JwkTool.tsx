import { useMemo } from "react";
import { CopyButton, HighlightedJsonEditor, HistoryList, useHistory, usePersistedField } from "./shared";

type Mode = "pem-to-jwk" | "jwk-to-pem";

export function JwkTool() {
  const [mode, setMode] = usePersistedField<Mode>("knock.tools.jwk.mode", "pem-to-jwk");
  const [input, setInput] = usePersistedField<string>("knock.tools.jwk.input", "");
  const history = useHistory("knock.tools.jwk.history");

  const output = useMemo(() => {
    if (!input.trim()) return "";
    try {
      if (mode === "pem-to-jwk") return pemToJwk(input);
      return jwkToPem(input);
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }, [input, mode]);

  return (
    <>
      <div className="tools-tabs">
        {(["pem-to-jwk", "jwk-to-pem"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <div className="tools-warning">
        Conversion only — does not verify or sign. RSA/EC public keys best supported. Components
        extracted from PEM via ASN.1 are not implemented; paste a JWK to convert to a JSON layout.
      </div>
      <label className="tools-label">Input</label>
      {mode === "jwk-to-pem" ? (
        <HighlightedJsonEditor value={input} onChange={setInput} />
      ) : (
        <textarea
          className="tools-textarea tools-textarea-tall"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => history.push(mode, input)}
          placeholder="-----BEGIN PUBLIC KEY-----..."
          spellCheck={false}
        />
      )}
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      <textarea className="tools-textarea tools-output tools-textarea-tall" value={output} readOnly spellCheck={false} />
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

function pemToJwk(pem: string): string {
  // Extract base64 body
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("Empty PEM body");
  // Without full ASN.1, just present base64-decoded as opaque DER reference
  return JSON.stringify(
    {
      note: "Full PEM → JWK extraction not implemented. Use Web Crypto importKey + exportKey('jwk') in a script.",
      pem_body_base64: body,
      length_bytes: Math.floor((body.length * 3) / 4),
    },
    null,
    2,
  );
}

function jwkToPem(jwkJson: string): string {
  const jwk = JSON.parse(jwkJson);
  if (jwk.kty !== "RSA") {
    throw new Error("Only RSA JWK → PEM supported here (provide kty=RSA, n, e).");
  }
  if (!jwk.n || !jwk.e) throw new Error("JWK needs n and e");
  // Build a SubjectPublicKeyInfo DER for RSA public key
  const n = b64UrlToBytes(jwk.n);
  const e = b64UrlToBytes(jwk.e);
  const rsaKey = derSequence([derInteger(n), derInteger(e)]);
  // AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1) + NULL
  const algId = derSequence([
    new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]),
    new Uint8Array([0x05, 0x00]),
  ]);
  const bitString = new Uint8Array(rsaKey.length + 1);
  bitString[0] = 0x00;
  bitString.set(rsaKey, 1);
  const wrapped = derBitString(bitString);
  const spki = derSequence([algId, wrapped]);
  const b64 = bytesToBase64(spki);
  const wrapped64 = b64.replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN PUBLIC KEY-----\n${wrapped64}\n-----END PUBLIC KEY-----\n`;
}

function b64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const std = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function derLength(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derEncode(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function derSequence(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return derEncode(0x30, buf);
}

function derInteger(bytes: Uint8Array): Uint8Array {
  const needsPad = bytes[0] & 0x80;
  const content = needsPad ? new Uint8Array([0, ...bytes]) : bytes;
  return derEncode(0x02, content);
}

function derBitString(bytes: Uint8Array): Uint8Array {
  return derEncode(0x03, bytes);
}
