import { useEffect, useMemo, useRef, useState } from "react";
import {
  auditJwt,
  checkExpectations,
  CLAIM_DOCS,
  decodeJwt,
  findWeakHmacSecret,
  signJwt,
  verifyJwt,
  type VerifyResult,
} from "../security/jwt";
import { algSpec, generateKeyPair, JWT_ALGS, KEY_PAIR_KINDS, type GeneratedKeyPair } from "../security/keys";
import {
  CopyButton,
  HighlightedJsonEditor,
  HistoryList,
  escapeHtml,
  relTime,
  useHistory,
  usePersistedField,
} from "./shared";
import { FindingsList, LocalOnlyNote, SeveritySummary } from "./securityUi";

type Mode = "decode" | "build";

const DATE_CLAIMS = new Set(["exp", "iat", "nbf", "auth_time", "updated_at"]);

export function JwtTool() {
  const [mode, setMode] = usePersistedField<Mode>("knock.tools.jwt.mode", "decode");
  const [token, setToken] = usePersistedField<string>("knock.tools.jwt.input", "");
  // Secrets and private keys live only in memory: they are credentials.
  const [secret, setSecret] = useState("");
  const [secretIsBase64, setSecretIsBase64] = useState(false);
  const [publicKey, setPublicKey] = usePersistedField<string>("knock.tools.jwt.publicKey", "");
  const [seed, setSeed] = useState<{ header: string; payload: string } | null>(null);

  return (
    <>
      <div className="tools-tabs">
        <button className={mode === "decode" ? "active" : ""} onClick={() => setMode("decode")}>
          Decode &amp; verify
        </button>
        <button className={mode === "build" ? "active" : ""} onClick={() => setMode("build")}>
          Build &amp; sign
        </button>
      </div>
      {mode === "decode" ? (
        <JwtDecoder
          token={token}
          setToken={setToken}
          secret={secret}
          setSecret={setSecret}
          secretIsBase64={secretIsBase64}
          setSecretIsBase64={setSecretIsBase64}
          publicKey={publicKey}
          setPublicKey={setPublicKey}
          onEdit={(header, payload) => {
            setSeed({ header, payload });
            setMode("build");
          }}
        />
      ) : (
        <JwtBuilder
          seed={seed}
          onSeedUsed={() => setSeed(null)}
          secret={secret}
          setSecret={setSecret}
          secretIsBase64={secretIsBase64}
          setSecretIsBase64={setSecretIsBase64}
          onVerify={(t, pub) => {
            setToken(t);
            if (pub) setPublicKey(pub);
            setMode("decode");
          }}
        />
      )}
    </>
  );
}

/* ---------------- decoder ---------------- */

function JwtDecoder({
  token,
  setToken,
  secret,
  setSecret,
  secretIsBase64,
  setSecretIsBase64,
  publicKey,
  setPublicKey,
  onEdit,
}: {
  token: string;
  setToken: (v: string) => void;
  secret: string;
  setSecret: (v: string) => void;
  secretIsBase64: boolean;
  setSecretIsBase64: (v: boolean) => void;
  publicKey: string;
  setPublicKey: (v: string) => void;
  onEdit: (header: string, payload: string) => void;
}) {
  const history = useHistory("knock.tools.jwt.history");
  const [expIss, setExpIss] = usePersistedField<string>("knock.tools.jwt.expectIss", "");
  const [expAud, setExpAud] = usePersistedField<string>("knock.tools.jwt.expectAud", "");
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [cracked, setCracked] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const decoded = useMemo(() => (token.trim() ? decodeJwt(token) : null), [token]);
  const jwt = decoded?.ok ? decoded.jwt : null;
  const spec = jwt?.alg ? algSpec(jwt.alg) : null;
  const isHmac = spec?.family === "hmac";

  useEffect(() => {
    if (!jwt) {
      setVerify(null);
      return;
    }
    let active = true;
    const id = window.setTimeout(() => {
      void verifyJwt(token, { secret, secretIsBase64, keyText: isHmac ? undefined : publicKey }).then((r) => {
        if (active) setVerify(r);
      });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(id);
    };
  }, [token, secret, secretIsBase64, publicKey, isHmac, jwt]);

  useEffect(() => {
    setCracked(null);
    if (!jwt || !isHmac) return;
    let active = true;
    void findWeakHmacSecret(token).then((s) => {
      if (active) setCracked(s);
    });
    return () => {
      active = false;
    };
  }, [token, isHmac, jwt]);

  const findings = useMemo(
    () =>
      jwt
        ? auditJwt(jwt.header, jwt.payload, {
            now,
            secret: isHmac ? secret : undefined,
            secretIsBase64,
            crackedSecret: cracked,
            tokenLength: token.trim().length,
          })
        : [],
    [jwt, now, isHmac, secret, secretIsBase64, cracked, token],
  );

  const expectations = useMemo(
    () =>
      jwt?.payload
        ? checkExpectations(jwt.payload, { iss: expIss.trim() || undefined, aud: expAud.trim() || undefined, now })
        : [],
    [jwt, expIss, expAud, now],
  );

  return (
    <>
      <label className="tools-label">Token</label>
      <ColorizedTokenView token={token} onChange={setToken} onBlur={() => history.push("jwt", token)} />
      {decoded && !decoded.ok && <div className="tools-error">{decoded.error}</div>}

      {jwt && (
        <>
          <VerifyBadge result={verify} cracked={cracked} />

          {spec && spec.family !== "none" && (
            <>
              {isHmac ? (
                <>
                  <div className="tools-output-header">
                    <span>Secret to verify</span>
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
                    type="password"
                    className="tools-input"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="HMAC secret (kept in memory only)"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </>
              ) : (
                <>
                  <label className="tools-label">Public key to verify</label>
                  <textarea
                    className="tools-textarea sec-key-input"
                    value={publicKey}
                    onChange={(e) => setPublicKey(e.target.value)}
                    placeholder={"PEM (-----BEGIN PUBLIC KEY-----), certificate, JWK or JWKS ({\"keys\": [...]})"}
                    spellCheck={false}
                  />
                </>
              )}
            </>
          )}

          <div className="tools-output-header tools-section-header header-color">
            <span>Header {jwt.alg ? `· ${jwt.alg}` : ""}</span>
            <CopyButton text={jwt.headerText} />
          </div>
          <ClaimsTable obj={jwt.header} now={now} />

          <div className="tools-output-header tools-section-header payload-color">
            <span>Payload</span>
            <CopyButton text={jwt.payload ? JSON.stringify(jwt.payload, null, 2) : jwt.payloadText} />
          </div>
          {jwt.payload ? (
            <ClaimsTable obj={jwt.payload} now={now} />
          ) : (
            <pre className="tools-pre">{jwt.payloadText}</pre>
          )}

          <div className="tools-output-header">
            <span>
              Security audit <SeveritySummary findings={findings} />
            </span>
          </div>
          <FindingsList findings={findings} empty="No security issues detected." />

          {jwt.payload && (
            <>
              <div className="tools-output-header">
                <span>Server-side checks</span>
              </div>
              <div className="sec-expect-inputs">
                <input
                  className="tools-input"
                  value={expIss}
                  onChange={(e) => setExpIss(e.target.value)}
                  placeholder="Expected issuer (iss)"
                  spellCheck={false}
                />
                <input
                  className="tools-input"
                  value={expAud}
                  onChange={(e) => setExpAud(e.target.value)}
                  placeholder="Expected audience (aud)"
                  spellCheck={false}
                />
              </div>
              {expectations.length > 0 && (
                <ul className="sec-checks">
                  {expectations.map((r) => (
                    <li key={r.claim} className={r.ok ? "ok" : "fail"}>
                      <span>{r.ok ? "✓" : "✗"}</span>
                      <code>{r.claim}</code> {r.message}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <button
            className="tools-generate"
            onClick={() =>
              onEdit(
                JSON.stringify(jwt.header, null, 2),
                jwt.payload ? JSON.stringify(jwt.payload, null, 2) : jwt.payloadText,
              )
            }
          >
            Edit &amp; re-sign…
          </button>
        </>
      )}

      <HistoryList history={history} onPick={setToken} />
    </>
  );
}

function VerifyBadge({ result, cracked }: { result: VerifyResult | null; cracked: string | null }) {
  if (!result) return null;
  const tone =
    result.status === "valid" ? "ok" : result.status === "invalid" || result.status === "unsigned" ? "bad" : "neutral";
  const icon = result.status === "valid" ? "✓" : result.status === "invalid" ? "✗" : result.status === "unsigned" ? "!" : "…";
  return (
    <div className={`sec-verify sec-verify-${tone}`}>
      <span className="sec-verify-icon">{icon}</span>
      <span>{result.message}</span>
      {cracked !== null && result.status !== "valid" && (
        <span className="sec-verify-note">signed with the public secret "{cracked}"</span>
      )}
    </div>
  );
}

function formatClaimValue(key: string, value: unknown, now: number): { text: string; hint?: string; tone?: string } {
  if (DATE_CLAIMS.has(key) && typeof value === "number") {
    const ms = value * 1000;
    let tone: string | undefined;
    if (key === "exp" && ms < now) tone = "bad";
    if (key === "nbf" && ms > now) tone = "warn";
    return { text: String(value), hint: `${new Date(ms).toLocaleString()} · ${relTime(ms)}`, tone };
  }
  if (typeof value === "string") return { text: value };
  return { text: JSON.stringify(value) };
}

function ClaimsTable({ obj, now }: { obj: Record<string, unknown>; now: number }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <div className="tools-hint">(empty)</div>;
  return (
    <div className="sec-claims">
      {entries.map(([k, v]) => {
        const f = formatClaimValue(k, v, now);
        return (
          <div key={k} className="sec-claim" title={CLAIM_DOCS[k]}>
            <code className="sec-claim-key">{k}</code>
            <div className="sec-claim-body">
              <span className={`sec-claim-value ${f.tone ?? ""}`}>{f.text}</span>
              {f.hint && <span className={`sec-claim-hint ${f.tone ?? ""}`}>{f.hint}</span>}
              {CLAIM_DOCS[k] && <span className="sec-claim-doc">{CLAIM_DOCS[k]}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- builder ---------------- */

function JwtBuilder({
  seed,
  onSeedUsed,
  secret,
  setSecret,
  secretIsBase64,
  setSecretIsBase64,
  onVerify,
}: {
  /** Header/payload handed over by the decoder's "Edit & re-sign". */
  seed: { header: string; payload: string } | null;
  onSeedUsed: () => void;
  secret: string;
  setSecret: (v: string) => void;
  secretIsBase64: boolean;
  setSecretIsBase64: (v: boolean) => void;
  onVerify: (token: string, publicKey?: string) => void;
}) {
  const [headerText, setHeaderText] = usePersistedField<string>(
    "knock.tools.jwt.header",
    '{\n  "alg": "HS256",\n  "typ": "JWT"\n}',
  );
  const [payloadText, setPayloadText] = usePersistedField<string>(
    "knock.tools.jwt.payload",
    '{\n  "sub": "1234567890",\n  "name": "John Doe",\n  "iat": 1516239022\n}',
  );
  const [privateKey, setPrivateKey] = useState("");
  const [generated, setGenerated] = useState<GeneratedKeyPair | null>(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!seed) return;
    setHeaderText(seed.header);
    setPayloadText(seed.payload);
    onSeedUsed();
  }, [seed, setHeaderText, setPayloadText, onSeedUsed]);

  const header = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(headerText) as Record<string, unknown> };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  }, [headerText]);
  const payload = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(payloadText) as Record<string, unknown> };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  }, [payloadText]);

  const alg = header.ok && typeof header.value.alg === "string" ? header.value.alg : "";
  const spec = algSpec(alg);

  useEffect(() => {
    if (!header.ok || !payload.ok) {
      setOutput("");
      return;
    }
    let active = true;
    const id = window.setTimeout(() => {
      signJwt(headerText, payloadText, { secret, secretIsBase64, keyText: privateKey })
        .then((t) => {
          if (!active) return;
          setOutput(t);
          setError(null);
        })
        .catch((e: Error) => {
          if (!active) return;
          setOutput("");
          setError(e.message);
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(id);
    };
  }, [headerText, payloadText, secret, secretIsBase64, privateKey, header.ok, payload.ok]);

  function setAlg(next: string) {
    const h: Record<string, unknown> = header.ok ? { ...header.value } : { typ: "JWT" };
    h.alg = next;
    if (generated && generated.alg !== next) delete h.kid;
    setHeaderText(JSON.stringify(h, null, 2));
  }

  function patchPayload(patch: Record<string, number>) {
    if (!payload.ok) return;
    setPayloadText(JSON.stringify({ ...payload.value, ...patch }, null, 2));
  }

  async function generate() {
    const kind =
      spec?.family === "ec"
        ? (spec.curve as GeneratedKeyPair["kind"])
        : spec?.family === "ed"
          ? "Ed25519"
          : "RSA-2048";
    setBusy(true);
    try {
      const kp = await generateKeyPair(kind);
      setGenerated(kp);
      setPrivateKey(kp.privatePem);
      if (header.ok) setHeaderText(JSON.stringify({ ...header.value, kid: kp.kid }, null, 2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <>
      <label className="tools-label">Algorithm</label>
      <div className="tools-tabs tools-tabs-wrap sec-alg-tabs">
        {JWT_ALGS.map((a) => (
          <button key={a} className={alg === a ? "active" : ""} onClick={() => setAlg(a)}>
            {a}
          </button>
        ))}
      </div>

      <div className="tools-output-header tools-section-header header-color">
        <span>Header</span>
        <CopyButton text={headerText} />
      </div>
      <HighlightedJsonEditor value={headerText} onChange={setHeaderText} className="jwt-header-editor" />
      {!header.ok && <div className="tools-error">Header: {header.error}</div>}

      <div className="tools-output-header tools-section-header payload-color">
        <span>Payload</span>
        <CopyButton text={payloadText} />
      </div>
      <HighlightedJsonEditor value={payloadText} onChange={setPayloadText} className="jwt-payload-editor" />
      {!payload.ok && <div className="tools-error">Payload: {payload.error}</div>}
      <div className="tools-date-actions">
        <button onClick={() => patchPayload({ iat: nowSec })}>iat = now</button>
        <button onClick={() => patchPayload({ exp: nowSec + 900 })}>exp = +15m</button>
        <button onClick={() => patchPayload({ exp: nowSec + 3600 })}>exp = +1h</button>
        <button onClick={() => patchPayload({ exp: nowSec + 86400 })}>exp = +1d</button>
        <button onClick={() => patchPayload({ nbf: nowSec })}>nbf = now</button>
      </div>

      {spec?.family === "hmac" && (
        <>
          <div className="tools-output-header">
            <span>Secret</span>
            <label className="tools-checkbox">
              <input type="checkbox" checked={secretIsBase64} onChange={(e) => setSecretIsBase64(e.target.checked)} />
              base64
            </label>
          </div>
          <input
            type="password"
            className="tools-input"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={`At least ${spec.hashBytes} random bytes`}
            spellCheck={false}
            autoComplete="off"
          />
        </>
      )}
      {spec && spec.family !== "hmac" && spec.family !== "none" && (
        <>
          <div className="tools-output-header">
            <span>Private key</span>
            <button className="tools-copy" onClick={generate} disabled={busy}>
              {busy ? "Generating…" : "Generate key pair"}
            </button>
          </div>
          <textarea
            className="tools-textarea sec-key-input"
            value={privateKey}
            onChange={(e) => {
              setPrivateKey(e.target.value);
              setGenerated(null);
            }}
            placeholder="-----BEGIN PRIVATE KEY----- (PKCS#8, PKCS#1, SEC1) or a private JWK"
            spellCheck={false}
          />
          {generated && (
            <div className="sec-generated">
              <div className="tools-output-header">
                <span>Public key · kid {generated.kid.slice(0, 10)}…</span>
                <span className="tools-row">
                  <CopyButton text={generated.publicPem} />
                </span>
              </div>
              <pre className="tools-pre sec-key-pre">{generated.publicPem}</pre>
              <div className="tools-output-header">
                <span>JWKS</span>
                <CopyButton text={JSON.stringify({ keys: [generated.publicJwk] }, null, 2)} />
              </div>
            </div>
          )}
        </>
      )}
      {!spec && alg && <div className="tools-error">Unsupported alg "{alg}"</div>}
      {spec?.family === "none" && (
        <div className="tools-warning">alg none produces an unsigned token. Only use it to test that servers reject it.</div>
      )}

      <div className="tools-output-header">
        <span>Signed token</span>
        <CopyButton text={output} />
      </div>
      {error ? <div className="tools-error">{error}</div> : <pre className="tools-pre sec-token-out">{output}</pre>}
      {output && (
        <button className="tools-generate" onClick={() => onVerify(output, generated?.publicPem)}>
          Verify in decoder →
        </button>
      )}
      <LocalOnlyNote>Secrets and private keys stay in memory only — they are never saved.</LocalOnlyNote>
      <KeyKindsHint />
    </>
  );
}

function KeyKindsHint() {
  return (
    <div className="tools-hint">
      Key pairs: {KEY_PAIR_KINDS.map((k) => k.label).join(" · ")}. Generated with WebCrypto on this device.
    </div>
  );
}

/* ---------------- token view ---------------- */

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
    const [h, p, s, ...rest] = token.split(".");
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
        placeholder="Paste a JWT (eyJhbGciOi…) or a Bearer header value"
        spellCheck={false}
      />
    </div>
  );
}
