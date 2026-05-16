import { useEffect, useState } from "react";
import { CopyButton, HistoryList, bytesToHex, useHistory, usePersistedField } from "./shared";

type Algo = "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

const ALGOS: Algo[] = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"];

export function HashTool() {
  const [text, setText] = usePersistedField<string>("knock.tools.hash.input", "");
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const history = useHistory("knock.tools.hash.history");

  useEffect(() => {
    let active = true;
    (async () => {
      const next: Record<string, string> = {};
      for (const algo of ALGOS) {
        try {
          next[algo] = await hash(algo, text);
        } catch (e) {
          next[algo] = `Error: ${String(e)}`;
        }
      }
      if (active) setHashes(next);
    })();
    return () => {
      active = false;
    };
  }, [text]);

  return (
    <>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => history.push("hash", text)}
        spellCheck={false}
        placeholder="Text to hash"
      />
      {ALGOS.map((algo) => (
        <div key={algo}>
          <div className="tools-output-header">
            <span>{algo}</span>
            <CopyButton text={hashes[algo] ?? ""} />
          </div>
          <pre className="tools-pre">{hashes[algo] ?? ""}</pre>
        </div>
      ))}
      <HistoryList history={history} onPick={setText} />
    </>
  );
}

async function hash(algo: Algo, text: string): Promise<string> {
  if (!text) return "";
  const data = new TextEncoder().encode(text);
  if (algo === "MD5") return md5(text);
  const buf = await crypto.subtle.digest(algo, data as BufferSource);
  return bytesToHex(new Uint8Array(buf));
}

// MD5 implementation (RFC 1321)
function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const msg = new Uint8Array(bytes);
  const bitLen = msg.length * 8;
  const padLen = ((msg.length + 8) % 64 < 56 ? 56 : 120) - (msg.length % 64);
  const padded = new Uint8Array(msg.length + padLen + 8);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const u32 = (x: number) => x >>> 0;
  const rotl = (x: number, n: number) => u32((x << n) | (x >>> (32 - n)));

  for (let off = 0; off < padded.length; off += 64) {
    const M = new Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0,
        g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = u32(F + A + K[i] + M[g]);
      A = D;
      D = C;
      C = B;
      B = u32(B + rotl(F, S[i]));
    }
    a0 = u32(a0 + A);
    b0 = u32(b0 + B);
    c0 = u32(c0 + C);
    d0 = u32(d0 + D);
  }

  function toHex(n: number): string {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}
