import { useState } from "react";
import { generateKeyPair, KEY_PAIR_KINDS, type GeneratedKeyPair, type KeyPairKind } from "../security/keys";
import { CopyButton, usePersistedField } from "./shared";
import { LocalOnlyNote } from "./securityUi";

export function KeyPairTool() {
  const [kind, setKind] = usePersistedField<KeyPairKind>("knock.tools.keypair.kind", "P-256");
  // The generated pair is never persisted.
  const [pair, setPair] = useState<GeneratedKeyPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setPair(await generateKeyPair(kind));
    } catch (e) {
      setError(
        kind === "Ed25519"
          ? `${(e as Error).message} — this webview may not support Ed25519 yet.`
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  const blocks = pair
    ? [
        { label: "Public key (PEM, SPKI)", text: pair.publicPem },
        { label: "Private key (PEM, PKCS#8)", text: pair.privatePem, secret: true },
        { label: "JWKS (public — publish this)", text: JSON.stringify({ keys: [pair.publicJwk] }, null, 2) },
        { label: "Private JWK", text: JSON.stringify(pair.privateJwk, null, 2), secret: true },
      ]
    : [];

  return (
    <>
      <label className="tools-label">Key type</label>
      <div className="tools-tabs tools-tabs-wrap">
        {KEY_PAIR_KINDS.map((k) => (
          <button key={k.kind} className={kind === k.kind ? "active" : ""} onClick={() => setKind(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>
      <button className="tools-generate" onClick={generate} disabled={busy}>
        {busy ? "Generating…" : "Generate key pair"}
      </button>
      {error && <div className="tools-error">{error}</div>}
      {pair && (
        <>
          <div className="tools-hint">
            JWT alg <code>{pair.alg}</code> · kid (RFC 7638 thumbprint) <code>{pair.kid}</code>
          </div>
          {blocks.map((b) => (
            <div key={b.label}>
              <div className="tools-output-header">
                <span>
                  {b.label}
                  {b.secret && <span className="sec-chip sec-high sec-inline">secret</span>}
                </span>
                <CopyButton text={b.text} />
              </div>
              <pre className="tools-pre sec-key-pre">{b.text}</pre>
            </div>
          ))}
        </>
      )}
      <LocalOnlyNote>Keys are generated with WebCrypto on this device and are not saved.</LocalOnlyNote>
    </>
  );
}
