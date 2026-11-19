// JWT decode / verify / sign / audit. Pure (WebCrypto only), unit-tested.

import { base64UrlToBytes, buf, bytesToBase64Url, fromUtf8, utf8 } from "./encoding.js";
import {
  algSpec,
  importKeyForAlg,
  secretBytes,
  webCryptoParams,
  type KeyInput,
} from "./keys.js";

export interface DecodedJwt {
  header: Record<string, unknown>;
  /** Parsed payload, or null when it is not a JSON object. */
  payload: Record<string, unknown> | null;
  headerText: string;
  payloadText: string;
  signature: string;
  signingInput: string;
  alg: string | null;
  kid: string | null;
}

export type DecodeResult = { ok: true; jwt: DecodedJwt } | { ok: false; error: string };

export function decodeJwt(input: string): DecodeResult {
  const token = input.trim().replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, error: "empty token" };
  const parts = token.split(".");
  if (parts.length === 5) {
    return { ok: false, error: "This is a JWE (encrypted JWT, 5 segments): the payload can't be read without the decryption key." };
  }
  if (parts.length !== 3) {
    return { ok: false, error: `A JWT has 3 dot-separated segments; this has ${parts.length}.` };
  }
  const [h, p, s] = parts;
  let headerText: string;
  let header: Record<string, unknown>;
  try {
    headerText = fromUtf8(base64UrlToBytes(h));
    const parsed = JSON.parse(headerText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    header = parsed;
  } catch (e) {
    return { ok: false, error: `Header is not valid base64url JSON: ${(e as Error).message}` };
  }
  let payloadText: string;
  try {
    payloadText = fromUtf8(base64UrlToBytes(p));
  } catch (e) {
    return { ok: false, error: `Payload is not valid base64url UTF-8: ${(e as Error).message}` };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(payloadText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    payload = null;
  }
  try {
    base64UrlToBytes(s);
  } catch (e) {
    return { ok: false, error: `Signature: ${(e as Error).message}` };
  }
  return {
    ok: true,
    jwt: {
      header,
      payload,
      headerText,
      payloadText,
      signature: s,
      signingInput: `${h}.${p}`,
      alg: typeof header.alg === "string" ? header.alg : null,
      kid: typeof header.kid === "string" ? header.kid : null,
    },
  };
}

/** base64url of the minified JSON (falls back to the raw text when it isn't JSON). */
export function encodeSegment(jsonText: string): string {
  let canonical = jsonText;
  try {
    canonical = JSON.stringify(JSON.parse(jsonText));
  } catch {
    /* keep raw */
  }
  return bytesToBase64Url(utf8(canonical));
}

export type VerifyStatus = "valid" | "invalid" | "unsigned" | "needs-key" | "error";

export interface VerifyResult {
  status: VerifyStatus;
  message: string;
}

export async function verifyJwt(token: string, key: KeyInput): Promise<VerifyResult> {
  const d = decodeJwt(token);
  if (!d.ok) return { status: "error", message: d.error };
  const { alg, kid, signature, signingInput } = d.jwt;
  if (!alg) return { status: "error", message: "header has no alg" };
  if (alg === "none") {
    return signature
      ? { status: "invalid", message: "alg none must have an empty signature" }
      : { status: "unsigned", message: "Unsigned token (alg: none)" };
  }
  const spec = algSpec(alg);
  if (!spec) return { status: "error", message: `unsupported alg "${alg}"` };
  const hasKey =
    spec.family === "hmac" ? Boolean(key.secret || key.keyText?.trim()) : Boolean(key.keyText?.trim());
  if (!hasKey) {
    return {
      status: "needs-key",
      message: spec.family === "hmac" ? "Enter the secret to verify" : "Paste the public key, JWK or JWKS to verify",
    };
  }
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await importKeyForAlg(alg, key, "verify", kid ?? undefined);
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
  try {
    const ok = await crypto.subtle.verify(
      webCryptoParams(spec).signAlg,
      cryptoKey,
      buf(base64UrlToBytes(signature)),
      buf(utf8(signingInput)),
    );
    return ok
      ? { status: "valid", message: "Signature verified" }
      : { status: "invalid", message: "Signature does not match this key" };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

export async function signJwt(headerText: string, payloadText: string, key: KeyInput): Promise<string> {
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerText);
  } catch (e) {
    throw new Error(`Header JSON: ${(e as Error).message}`);
  }
  const alg = typeof header.alg === "string" ? header.alg : null;
  if (!alg) throw new Error("header needs an alg");
  const signingInput = `${encodeSegment(headerText)}.${encodeSegment(payloadText)}`;
  if (alg === "none") return `${signingInput}.`;
  const spec = algSpec(alg);
  if (!spec) throw new Error(`unsupported alg "${alg}"`);
  const cryptoKey = await importKeyForAlg(alg, key, "sign");
  const sig = await crypto.subtle.sign(webCryptoParams(spec).signAlg, cryptoKey, buf(utf8(signingInput)));
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

// -------- audit --------

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  code: string;
  title: string;
  detail?: string;
}

/** Secrets that show up in tutorials, defaults and leaked configs. */
export const COMMON_HMAC_SECRETS = [
  "secret",
  "your-256-bit-secret",
  "your-384-bit-secret",
  "your-512-bit-secret",
  "your_secret_key",
  "your-secret-key",
  "secretkey",
  "secret_key",
  "secret-key",
  "jwt_secret",
  "jwt-secret",
  "jwtsecret",
  "mysecret",
  "my_secret",
  "my-secret",
  "supersecret",
  "super-secret",
  "changeme",
  "change-me",
  "changeit",
  "password",
  "password123",
  "123456",
  "12345678",
  "qwerty",
  "admin",
  "test",
  "testing",
  "dev",
  "development",
  "default",
  "key",
  "private",
  "s3cr3t",
  "shhhhh",
  "keyboard cat",
  "token",
  "auth",
  "jwt",
  "hello",
];

/**
 * Try well-known secrets against an HS* token. Returns the secret that
 * verifies it, or null. Meant for auditing your own tokens: a hit means anyone
 * can forge tokens for that service.
 */
export async function findWeakHmacSecret(token: string): Promise<string | null> {
  const d = decodeJwt(token);
  if (!d.ok || !d.jwt.alg) return null;
  const spec = algSpec(d.jwt.alg);
  if (!spec || spec.family !== "hmac") return null;
  for (const secret of COMMON_HMAC_SECRETS) {
    const r = await verifyJwt(token, { secret });
    if (r.status === "valid") return secret;
  }
  return null;
}

const SENSITIVE_KEY_RE =
  /(pass(word|wd)?|secret|ssn|social.?security|credit.?card|card.?number|cvv|cvc|pin$|private.?key|api.?key)/i;

function walkKeys(obj: unknown, path: string[] = [], out: string[] = []): string[] {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = [...path, k];
      if (SENSITIVE_KEY_RE.test(k)) out.push(p.join("."));
      walkKeys(v, p, out);
    }
  }
  return out;
}

export interface AuditOptions {
  /** Current time in ms. */
  now: number;
  /** Secret entered for HS* tokens, to judge its strength. */
  secret?: string;
  secretIsBase64?: boolean;
  /** Result of findWeakHmacSecret, when it was run. */
  crackedSecret?: string | null;
  tokenLength?: number;
}

const DAY = 86400;

export function auditJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  opts: AuditOptions,
): Finding[] {
  const f: Finding[] = [];
  const alg = typeof header.alg === "string" ? header.alg : null;
  const spec = alg ? algSpec(alg) : null;
  const nowSec = Math.floor(opts.now / 1000);

  if (!alg) {
    f.push({ severity: "high", code: "alg-missing", title: "Header has no alg", detail: "Verifiers can't know how to check the signature." });
  } else if (alg.toLowerCase() === "none") {
    f.push({
      severity: "high",
      code: "alg-none",
      title: "Unsigned token (alg: none)",
      detail: "Anyone can create or modify it. Servers must reject alg none outright.",
    });
  } else if (!spec) {
    f.push({ severity: "medium", code: "alg-unknown", title: `Unknown alg "${alg}"` });
  }

  if (opts.crackedSecret != null) {
    f.push({
      severity: "high",
      code: "secret-cracked",
      title: `Signed with a well-known secret: "${opts.crackedSecret}"`,
      detail: "Anyone can forge valid tokens. Rotate to a random secret of at least 32 bytes.",
    });
  }

  if (spec?.family === "hmac" && opts.secret) {
    if (/-----BEGIN [A-Z ]*PUBLIC KEY-----|-----BEGIN CERTIFICATE-----/.test(opts.secret)) {
      f.push({
        severity: "high",
        code: "alg-confusion",
        title: "Public key used as an HMAC secret",
        detail:
          "This is the algorithm-confusion attack: if a server verifies HS tokens with its RSA/EC public key, anyone holding that public key can forge tokens. Pin the expected alg on the server.",
      });
    } else {
      let len = 0;
      try {
        len = secretBytes(opts.secret, opts.secretIsBase64 ?? false).length;
      } catch {
        len = 0;
      }
      const min = spec.hashBytes ?? 32;
      if (COMMON_HMAC_SECRETS.includes(opts.secret) && opts.crackedSecret == null) {
        f.push({ severity: "high", code: "secret-common", title: "Secret is a well-known default", detail: "It appears in public wordlists; tokens can be forged." });
      } else if (len > 0 && len < min) {
        f.push({
          severity: "medium",
          code: "secret-short",
          title: `Secret is ${len} bytes; ${alg} needs at least ${min}`,
          detail: "RFC 7518 §3.2 requires a key as long as the hash output. Short secrets can be brute-forced offline.",
        });
      }
    }
  }

  if (typeof header.jwk === "object" && header.jwk) {
    f.push({
      severity: "high",
      code: "embedded-jwk",
      title: "Header embeds its own key (jwk)",
      detail: "A verifier that trusts this key accepts tokens signed by anyone. Keys must come from the server's own configuration.",
    });
  }
  for (const h of ["jku", "x5u"] as const) {
    if (typeof header[h] === "string") {
      f.push({
        severity: "medium",
        code: `remote-key-${h}`,
        title: `Header points to a remote key URL (${h})`,
        detail: `${String(header[h])} — servers must only fetch keys from an allowlist, otherwise an attacker can host their own.`,
      });
    }
  }
  if (typeof header.kid === "string" && /(\.\.[\\/]|[';|`$]|\s(or|union|select)\s|^\/)/i.test(header.kid)) {
    f.push({
      severity: "medium",
      code: "kid-injection",
      title: "kid looks like an injection payload",
      detail: "Path traversal or SQL/shell characters in kid. Servers must treat kid as an opaque lookup key.",
    });
  }
  if (Array.isArray(header.crit) && header.crit.length > 0) {
    f.push({ severity: "info", code: "crit", title: `Critical header params: ${header.crit.join(", ")}`, detail: "Verifiers that don't understand them must reject the token." });
  }

  if (payload) {
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    const iat = typeof payload.iat === "number" ? payload.iat : null;
    const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
    if (exp === null) {
      f.push({ severity: "medium", code: "no-exp", title: "No expiration (exp)", detail: "A leaked token stays valid forever." });
    } else if (exp < nowSec) {
      f.push({ severity: "info", code: "expired", title: "Token is expired" });
    }
    if (exp !== null) {
      const start = iat ?? nbf ?? nowSec;
      const lifetime = exp - start;
      if (lifetime > 30 * DAY) {
        f.push({ severity: "medium", code: "long-lived", title: `Lifetime is ${Math.round(lifetime / DAY)} days`, detail: "Access tokens are usually minutes to hours; use refresh tokens for long sessions." });
      } else if (lifetime > DAY) {
        f.push({ severity: "low", code: "long-lived", title: `Lifetime is ${Math.round(lifetime / 3600)} hours` });
      }
    }
    if (nbf !== null && nbf > nowSec) {
      f.push({ severity: "info", code: "not-yet-valid", title: "Not valid yet (nbf is in the future)" });
    }
    if (iat !== null && iat > nowSec + 300) {
      f.push({ severity: "low", code: "iat-future", title: "Issued in the future (iat)", detail: "Clock skew on the issuer, or a forged token." });
    }
    if (payload.iss === undefined) {
      f.push({ severity: "low", code: "no-iss", title: "No issuer (iss)", detail: "Verifiers can't tell which service minted it." });
    }
    if (payload.aud === undefined) {
      f.push({ severity: "low", code: "no-aud", title: "No audience (aud)", detail: "The token could be replayed against another service that trusts the same issuer." });
    }
    const sensitive = walkKeys(payload);
    if (sensitive.length > 0) {
      f.push({
        severity: "medium",
        code: "sensitive-data",
        title: `Possibly sensitive fields: ${sensitive.join(", ")}`,
        detail: "JWT payloads are only base64-encoded — anyone holding the token can read them.",
      });
    }
  }

  if ((opts.tokenLength ?? 0) > 8192) {
    f.push({ severity: "low", code: "large", title: `Token is ${opts.tokenLength} bytes`, detail: "Many proxies cap headers at 8 KB." });
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  return f.sort((a, b) => order[a.severity] - order[b.severity]);
}

// -------- claims --------

export const CLAIM_DOCS: Record<string, string> = {
  iss: "Issuer — who created and signed the token.",
  sub: "Subject — the user or entity the token is about.",
  aud: "Audience — the service(s) meant to accept it.",
  exp: "Expiration time — reject at or after this moment.",
  nbf: "Not before — reject before this moment.",
  iat: "Issued at — when the token was created.",
  jti: "JWT ID — unique id, lets servers detect replay or revoke.",
  azp: "Authorized party — the OAuth client the token was issued to.",
  scope: "OAuth scopes granted (space-separated).",
  scp: "OAuth scopes granted (Azure AD / Okta form).",
  roles: "Roles granted to the subject.",
  groups: "Groups the subject belongs to.",
  client_id: "OAuth client that requested the token.",
  nonce: "OIDC nonce — binds the ID token to the login request.",
  auth_time: "When the user actually authenticated.",
  acr: "Authentication context class (assurance level).",
  amr: "Authentication methods used (pwd, mfa, otp…).",
  at_hash: "OIDC hash of the access token issued alongside.",
  c_hash: "OIDC hash of the authorization code.",
  sid: "Session id at the identity provider.",
  email: "User's email address.",
  email_verified: "Whether the IdP verified the email.",
  name: "User's full name.",
  preferred_username: "Username shown to the user.",
  tid: "Tenant id (Azure AD).",
  oid: "Object id of the user (Azure AD).",
  upn: "User principal name (Azure AD).",
  cnf: "Confirmation — key the token is bound to (DPoP / mTLS).",
  act: "Actor — who is acting on behalf of the subject (token exchange).",
  typ: "Token type.",
  alg: "Signature algorithm.",
  kid: "Key id — which of the issuer's keys signed it.",
  cty: "Content type of the payload (e.g. nested JWT).",
  jku: "URL of the JWKS holding the signing key.",
  jwk: "Public key embedded in the header.",
  x5u: "URL of the X.509 certificate chain.",
  x5c: "X.509 certificate chain embedded in the header.",
  x5t: "SHA-1 thumbprint of the signing certificate.",
  "x5t#S256": "SHA-256 thumbprint of the signing certificate.",
  crit: "Header params the verifier must understand.",
};

export interface Expectations {
  iss?: string;
  aud?: string;
  now: number;
  /** Allowed clock skew in seconds. */
  leeway?: number;
}

export interface ExpectationResult {
  claim: string;
  ok: boolean;
  message: string;
}

/** The checks a server would run: issuer, audience, exp/nbf with leeway. */
export function checkExpectations(
  payload: Record<string, unknown>,
  exp: Expectations,
): ExpectationResult[] {
  const out: ExpectationResult[] = [];
  const nowSec = Math.floor(exp.now / 1000);
  const leeway = exp.leeway ?? 0;
  if (exp.iss) {
    const ok = payload.iss === exp.iss;
    out.push({ claim: "iss", ok, message: ok ? "issuer matches" : `expected "${exp.iss}", got ${JSON.stringify(payload.iss)}` });
  }
  if (exp.aud) {
    const aud = payload.aud;
    const list = Array.isArray(aud) ? aud : aud === undefined ? [] : [aud];
    const ok = list.includes(exp.aud);
    out.push({ claim: "aud", ok, message: ok ? "audience matches" : `"${exp.aud}" not in ${JSON.stringify(aud)}` });
  }
  if (typeof payload.exp === "number") {
    const ok = nowSec < payload.exp + leeway;
    out.push({ claim: "exp", ok, message: ok ? "not expired" : "expired" });
  }
  if (typeof payload.nbf === "number") {
    const ok = nowSec >= payload.nbf - leeway;
    out.push({ claim: "nbf", ok, message: ok ? "already valid" : "not valid yet" });
  }
  return out;
}
