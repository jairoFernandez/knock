// Key handling for JWT signing/verification: PEM/JWK/JWKS/X.509 import via
// WebCrypto, key-pair generation and RFC 7638 thumbprints.

import { base64ToBytes, buf, bytesToBase64, bytesToBase64Url, utf8 } from "./encoding.js";

export type JwtAlg =
  | "HS256" | "HS384" | "HS512"
  | "RS256" | "RS384" | "RS512"
  | "PS256" | "PS384" | "PS512"
  | "ES256" | "ES384" | "ES512"
  | "EdDSA"
  | "none";

export const JWT_ALGS: JwtAlg[] = [
  "HS256", "HS384", "HS512",
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA", "none",
];

export type AlgFamily = "hmac" | "rsa" | "pss" | "ec" | "ed" | "none";

export interface AlgSpec {
  family: AlgFamily;
  hash?: "SHA-256" | "SHA-384" | "SHA-512";
  curve?: "P-256" | "P-384" | "P-521";
  /** Byte length of the hash; also the RFC 7518 minimum HMAC key length. */
  hashBytes?: number;
}

export function algSpec(alg: string): AlgSpec | null {
  if (alg === "none") return { family: "none" };
  if (alg === "EdDSA" || alg === "Ed25519") return { family: "ed" };
  const m = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg);
  if (!m) return null;
  const bits = m[2] as "256" | "384" | "512";
  const hash = `SHA-${bits}` as const;
  const hashBytes = Number(bits) / 8;
  switch (m[1]) {
    case "HS":
      return { family: "hmac", hash, hashBytes };
    case "RS":
      return { family: "rsa", hash, hashBytes };
    case "PS":
      return { family: "pss", hash, hashBytes };
    default:
      return {
        family: "ec",
        hash,
        hashBytes,
        curve: ({ "256": "P-256", "384": "P-384", "512": "P-521" } as const)[bits],
      };
  }
}

/** WebCrypto parameters for importKey and sign/verify. */
export function webCryptoParams(spec: AlgSpec): {
  importAlg: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams;
  signAlg: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
} {
  switch (spec.family) {
    case "hmac":
      return { importAlg: { name: "HMAC", hash: spec.hash! }, signAlg: { name: "HMAC" } };
    case "rsa":
      return {
        importAlg: { name: "RSASSA-PKCS1-v1_5", hash: spec.hash! },
        signAlg: { name: "RSASSA-PKCS1-v1_5" },
      };
    case "pss":
      return {
        importAlg: { name: "RSA-PSS", hash: spec.hash! },
        signAlg: { name: "RSA-PSS", saltLength: spec.hashBytes! },
      };
    case "ec":
      return {
        importAlg: { name: "ECDSA", namedCurve: spec.curve! },
        signAlg: { name: "ECDSA", hash: spec.hash! },
      };
    case "ed":
      return { importAlg: { name: "Ed25519" }, signAlg: { name: "Ed25519" } };
    default:
      throw new Error("alg none has no key");
  }
}

// -------- minimal DER --------

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>>= 8;
  }
  return [0x80 | out.length, ...out];
}

function tlv(tag: number, content: Uint8Array | number[]): Uint8Array {
  const body = content instanceof Uint8Array ? Array.from(content) : content;
  return new Uint8Array([tag, ...derLength(body.length), ...body]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface Tlv {
  tag: number;
  start: number; // first content byte
  end: number; // one past last content byte
  full: Uint8Array; // tag + length + content
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  const tag = bytes[offset];
  let len = bytes[offset + 1];
  let p = offset + 2;
  if (tag === undefined || len === undefined) throw new Error("truncated DER");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | bytes[p + i];
    p += n;
  }
  const end = p + len;
  if (end > bytes.length) throw new Error("truncated DER");
  return { tag, start: p, end, full: bytes.slice(offset, end) };
}

function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = parent.start;
  while (p < parent.end) {
    const t = readTlv(bytes, p);
    out.push(t);
    p = t.end;
  }
  return out;
}

const OID_RSA = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC_PUBLIC_KEY = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];

function rsaAlgId(): Uint8Array {
  return tlv(0x30, [...OID_RSA, 0x05, 0x00]);
}

/** PKCS#1 RSAPublicKey → SubjectPublicKeyInfo. */
export function pkcs1PublicToSpki(pkcs1: Uint8Array): Uint8Array {
  return tlv(0x30, concat(rsaAlgId(), tlv(0x03, concat(new Uint8Array([0]), pkcs1))));
}

/** PKCS#1 RSAPrivateKey → PKCS#8 PrivateKeyInfo. */
export function pkcs1PrivateToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return tlv(0x30, concat(tlv(0x02, [0]), rsaAlgId(), tlv(0x04, pkcs1)));
}

/** SEC1 ECPrivateKey (BEGIN EC PRIVATE KEY) → PKCS#8, reading the curve OID it embeds. */
export function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const root = readTlv(sec1, 0);
  const curveParam = children(sec1, root).find((c) => c.tag === 0xa0);
  if (!curveParam) throw new Error("EC private key does not name its curve");
  const curveOid = readTlv(sec1, curveParam.start).full;
  const algId = tlv(0x30, concat(new Uint8Array(OID_EC_PUBLIC_KEY), curveOid));
  return tlv(0x30, concat(tlv(0x02, [0]), algId, tlv(0x04, sec1)));
}

/** X.509 certificate → its SubjectPublicKeyInfo. */
export function certificateToSpki(cert: Uint8Array): Uint8Array {
  const root = readTlv(cert, 0);
  const tbs = children(cert, root)[0];
  if (!tbs) throw new Error("malformed certificate");
  const fields = children(cert, tbs);
  // [0] version is optional; then serial, signature, issuer, validity, subject, spki.
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const spki = fields[offset + 5];
  if (!spki || spki.tag !== 0x30) throw new Error("certificate has no public key");
  return spki.full;
}

// -------- PEM --------

export interface PemBlock {
  label: string;
  der: Uint8Array;
}

export function parsePem(text: string): PemBlock | null {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) return null;
  const body = m[2].replace(/^[A-Za-z-]+:.*$/gm, "").replace(/\s+/g, "");
  return { label: m[1], der: base64ToBytes(body) };
}

export function toPem(der: Uint8Array, label: string): string {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// -------- JWK / JWKS --------

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  d?: string;
  k?: string;
  [extra: string]: unknown;
}

const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

export function isPrivateJwk(jwk: Jwk): boolean {
  return jwk.kty !== "oct" && typeof jwk.d === "string";
}

/** Public half of a JWK (drops private members). */
export function publicJwk(jwk: Jwk): Jwk {
  const out: Jwk = { ...jwk };
  for (const f of PRIVATE_JWK_FIELDS) {
    if (f !== "k") delete out[f];
  }
  delete out.key_ops;
  return out;
}

function ktyForFamily(family: AlgFamily): string {
  return family === "ec" ? "EC" : family === "ed" ? "OKP" : family === "hmac" ? "oct" : "RSA";
}

/**
 * Pick the key for a token out of a JWKS: by kid when the token has one, else
 * the only key of a compatible type.
 */
export function selectJwk(keys: Jwk[], alg: string, kid?: string): Jwk {
  const spec = algSpec(alg);
  if (!spec) throw new Error(`unsupported alg ${alg}`);
  if (kid) {
    const byKid = keys.find((k) => k.kid === kid);
    if (!byKid) {
      const known = keys.map((k) => k.kid).filter(Boolean).join(", ") || "none";
      throw new Error(`no key with kid "${kid}" in the JWKS (kids: ${known})`);
    }
    return byKid;
  }
  const kty = ktyForFamily(spec.family);
  const compatible = keys.filter((k) => k.kty === kty && (!k.alg || k.alg === alg));
  if (compatible.length === 1) return compatible[0];
  if (compatible.length === 0) throw new Error(`no ${kty} key in the JWKS for ${alg}`);
  throw new Error("several keys match and the token has no kid; paste a single key");
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url). */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const members: Record<string, string[]> = {
    RSA: ["e", "kty", "n"],
    EC: ["crv", "kty", "x", "y"],
    OKP: ["crv", "kty", "x"],
    oct: ["k", "kty"],
  };
  const names = members[jwk.kty];
  if (!names) throw new Error(`unsupported kty ${jwk.kty}`);
  const obj: Record<string, unknown> = {};
  for (const n of names) {
    if (typeof jwk[n] !== "string") throw new Error(`JWK is missing "${n}"`);
    obj[n] = jwk[n];
  }
  const digest = await crypto.subtle.digest("SHA-256", buf(utf8(JSON.stringify(obj))));
  return bytesToBase64Url(new Uint8Array(digest));
}

// -------- import --------

export interface KeyInput {
  /** HMAC secret text. */
  secret?: string;
  secretIsBase64?: boolean;
  /** PEM, JWK, JWKS or certificate text for asymmetric algs. */
  keyText?: string;
}

export function secretBytes(secret: string, isBase64: boolean): Uint8Array {
  return isBase64 ? base64ToBytes(secret.trim()) : utf8(secret);
}

/**
 * Import the key a token needs. `usage` decides whether a private key is
 * required (sign) or a public one is enough (verify; private keys are reduced
 * to their public half).
 */
export async function importKeyForAlg(
  alg: string,
  input: KeyInput,
  usage: "sign" | "verify",
  kid?: string,
): Promise<CryptoKey> {
  const spec = algSpec(alg);
  if (!spec) throw new Error(`unsupported alg "${alg}"`);
  if (spec.family === "none") throw new Error("alg none has no key");
  const { importAlg } = webCryptoParams(spec);

  if (spec.family === "hmac") {
    const text = (input.keyText ?? "").trim();
    let raw: Uint8Array;
    if (text.startsWith("{")) {
      const jwk = parseJwkText(text, alg, kid);
      if (jwk.kty !== "oct" || typeof jwk.k !== "string") throw new Error("HS algs need an oct JWK");
      raw = base64ToBytes(jwk.k);
    } else {
      if (!input.secret) throw new Error("enter the HMAC secret");
      raw = secretBytes(input.secret, input.secretIsBase64 ?? false);
    }
    return crypto.subtle.importKey("raw", buf(raw), importAlg, false, [usage]);
  }

  const text = (input.keyText ?? "").trim();
  if (!text) throw new Error(usage === "sign" ? "paste a private key" : "paste a public key, JWK or JWKS");

  if (text.startsWith("{")) {
    let jwk = parseJwkText(text, alg, kid);
    if (jwk.alg && jwk.alg !== alg) {
      throw new Error(`key is for ${jwk.alg} but the token uses ${alg}`);
    }
    if (usage === "sign" && !isPrivateJwk(jwk)) throw new Error("signing needs a private JWK (with \"d\")");
    if (usage === "verify") jwk = publicJwk(jwk);
    const clean: Jwk = { ...jwk };
    delete clean.alg;
    delete clean.use;
    delete clean.key_ops;
    return crypto.subtle.importKey("jwk", clean as JsonWebKey, importAlg, false, [usage]);
  }

  const pem = parsePem(text);
  if (!pem) throw new Error("not a PEM block, JWK or JWKS");
  let format: "spki" | "pkcs8";
  let der: Uint8Array;
  switch (pem.label) {
    case "PUBLIC KEY":
      format = "spki";
      der = pem.der;
      break;
    case "RSA PUBLIC KEY":
      format = "spki";
      der = pkcs1PublicToSpki(pem.der);
      break;
    case "CERTIFICATE":
      format = "spki";
      der = certificateToSpki(pem.der);
      break;
    case "PRIVATE KEY":
      format = "pkcs8";
      der = pem.der;
      break;
    case "RSA PRIVATE KEY":
      format = "pkcs8";
      der = pkcs1PrivateToPkcs8(pem.der);
      break;
    case "EC PRIVATE KEY":
      format = "pkcs8";
      der = sec1ToPkcs8(pem.der);
      break;
    case "ENCRYPTED PRIVATE KEY":
      throw new Error("encrypted private keys are not supported; decrypt it first (openssl pkey -in key.pem)");
    default:
      throw new Error(`unsupported PEM type "${pem.label}"`);
  }

  if (format === "pkcs8" && usage === "verify") {
    // Derive the public half: import as extractable private, export JWK, strip.
    const priv = await crypto.subtle.importKey("pkcs8", buf(der), importAlg, true, ["sign"]);
    const jwk = (await crypto.subtle.exportKey("jwk", priv)) as Jwk;
    return crypto.subtle.importKey("jwk", publicJwk(jwk) as JsonWebKey, importAlg, false, ["verify"]);
  }
  if (format === "spki" && usage === "sign") throw new Error("signing needs a private key, not a public one");
  return crypto.subtle.importKey(format, buf(der), importAlg, false, [usage]);
}

function parseJwkText(text: string, alg: string, kid?: string): Jwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`key JSON is invalid: ${(e as Error).message}`);
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { keys?: unknown }).keys)) {
    return selectJwk((parsed as { keys: Jwk[] }).keys, alg, kid);
  }
  const jwk = parsed as Jwk;
  if (!jwk || typeof jwk.kty !== "string") throw new Error("JSON is neither a JWK nor a JWKS");
  return jwk;
}

// -------- generation --------

export type KeyPairKind =
  | "RSA-2048"
  | "RSA-3072"
  | "RSA-4096"
  | "P-256"
  | "P-384"
  | "P-521"
  | "Ed25519";

export const KEY_PAIR_KINDS: { kind: KeyPairKind; alg: JwtAlg; label: string }[] = [
  { kind: "RSA-2048", alg: "RS256", label: "RSA 2048 (RS256/PS256)" },
  { kind: "RSA-3072", alg: "RS384", label: "RSA 3072" },
  { kind: "RSA-4096", alg: "RS512", label: "RSA 4096" },
  { kind: "P-256", alg: "ES256", label: "EC P-256 (ES256)" },
  { kind: "P-384", alg: "ES384", label: "EC P-384 (ES384)" },
  { kind: "P-521", alg: "ES512", label: "EC P-521 (ES512)" },
  { kind: "Ed25519", alg: "EdDSA", label: "Ed25519 (EdDSA)" },
];

export interface GeneratedKeyPair {
  kind: KeyPairKind;
  alg: JwtAlg;
  kid: string;
  publicPem: string;
  privatePem: string;
  publicJwk: Jwk;
  privateJwk: Jwk;
}

export async function generateKeyPair(kind: KeyPairKind): Promise<GeneratedKeyPair> {
  const meta = KEY_PAIR_KINDS.find((k) => k.kind === kind);
  if (!meta) throw new Error(`unknown key kind ${kind}`);
  let algorithm: RsaHashedKeyGenParams | EcKeyGenParams | AlgorithmIdentifier;
  if (kind.startsWith("RSA-")) {
    algorithm = {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: Number(kind.slice(4)),
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    };
  } else if (kind === "Ed25519") {
    algorithm = { name: "Ed25519" };
  } else {
    algorithm = { name: "ECDSA", namedCurve: kind };
  }
  const pair = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pubJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  const privJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk;
  const kid = await jwkThumbprint(pubJwk);
  const decorate = (j: Jwk): Jwk => {
    const out: Jwk = { ...j, kid, alg: meta.alg, use: "sig" };
    delete out.key_ops;
    delete out.ext;
    return out;
  };
  return {
    kind,
    alg: meta.alg,
    kid,
    publicPem: toPem(spki, "PUBLIC KEY"),
    privatePem: toPem(pkcs8, "PRIVATE KEY"),
    publicJwk: decorate(pubJwk),
    privateJwk: decorate(privJwk),
  };
}
