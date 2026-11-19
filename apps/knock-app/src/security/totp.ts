// HOTP (RFC 4226) / TOTP (RFC 6238) and otpauth:// URI parsing. Unit-tested
// against the RFC test vectors.

import { base32ToBytes, buf } from "./encoding.js";

export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpConfig {
  secret: Uint8Array;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
}

const WEBCRYPTO_HASH: Record<OtpAlgorithm, string> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

export async function hotp(
  secret: Uint8Array,
  counter: number,
  algorithm: OtpAlgorithm = "SHA1",
  digits = 6,
): Promise<string> {
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    buf(secret),
    { name: "HMAC", hash: WEBCRYPTO_HASH[algorithm] },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpCounter(nowMs: number, period = 30): number {
  return Math.floor(nowMs / 1000 / period);
}

export function secondsRemaining(nowMs: number, period = 30): number {
  return period - (Math.floor(nowMs / 1000) % period);
}

export async function totp(cfg: TotpConfig, nowMs: number, stepOffset = 0): Promise<string> {
  return hotp(cfg.secret, totpCounter(nowMs, cfg.period) + stepOffset, cfg.algorithm, cfg.digits);
}

/** Accepts a bare base32 secret or an otpauth://totp/… URI. */
export function parseTotpInput(input: string): TotpConfig {
  const text = input.trim();
  if (!text) throw new Error("enter a base32 secret or an otpauth:// URI");
  if (!/^otpauth:\/\//i.test(text)) {
    return { secret: base32ToBytes(text), algorithm: "SHA1", digits: 6, period: 30 };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("malformed otpauth:// URI");
  }
  if (url.host.toLowerCase() !== "totp") {
    throw new Error(`only TOTP is supported (this URI is ${url.host || "unknown"})`);
  }
  const secret = url.searchParams.get("secret");
  if (!secret) throw new Error("URI has no secret parameter");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (!(algorithm in WEBCRYPTO_HASH)) throw new Error(`unsupported algorithm ${algorithm}`);
  const digits = Number(url.searchParams.get("digits") ?? 6);
  if (![6, 7, 8].includes(digits)) throw new Error(`unsupported digits ${digits}`);
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!Number.isInteger(period) || period <= 0) throw new Error(`invalid period ${period}`);
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const [labelIssuer, account] = label.includes(":") ? label.split(/:(.*)/s, 2) : [undefined, label];
  return {
    secret: base32ToBytes(secret),
    algorithm: algorithm as OtpAlgorithm,
    digits,
    period,
    issuer: url.searchParams.get("issuer") ?? labelIssuer?.trim(),
    account: account?.trim() || undefined,
  };
}
