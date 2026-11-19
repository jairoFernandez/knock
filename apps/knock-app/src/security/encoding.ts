// Byte/text encoding helpers shared by the security tools. No DOM: runs under
// plain Node for unit tests (atob/btoa/TextEncoder are globals there too).

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function base64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error("not valid base64url (only A-Z a-z 0-9 - _ allowed)");
  }
  return base64ToBytes(s);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Copy into a fresh ArrayBuffer-backed view, as WebCrypto's typings expect. */
export function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (the alphabet authenticator secrets use). Lenient on case, spaces, padding. */
export function base32ToBytes(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s-]+/g, "").replace(/=+$/, "");
  if (!clean) throw new Error("empty secret");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const len = [...s].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return h;
}
