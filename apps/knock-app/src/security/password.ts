// Password strength estimate: charset entropy with penalties for the patterns
// attackers try first. Not zxcvbn, but honest about common failure modes.

export const COMMON_PASSWORDS = new Set([
  "123456", "123456789", "12345678", "12345", "1234567", "1234567890", "111111",
  "000000", "123123", "password", "password1", "password123", "passw0rd", "qwerty",
  "qwerty123", "qwertyuiop", "abc123", "iloveyou", "admin", "admin123", "welcome",
  "welcome1", "letmein", "monkey", "dragon", "football", "baseball", "sunshine",
  "princess", "master", "shadow", "superman", "trustno1", "login", "starwars",
  "hello", "freedom", "whatever", "secret", "changeme", "default", "root", "toor",
  "test", "test123", "guest", "contraseña", "contrasena", "hola123", "temporal",
]);

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];

export interface PasswordReport {
  /** Estimated guesses in log2 (bits). */
  bits: number;
  score: 0 | 1 | 2 | 3 | 4;
  label: "Very weak" | "Weak" | "Fair" | "Strong" | "Very strong";
  charsetSize: number;
  warnings: string[];
  crackTimes: { scenario: string; seconds: number; display: string }[];
}

export function charsetSize(pw: string): number {
  let n = 0;
  if (/[a-z]/.test(pw)) n += 26;
  if (/[A-Z]/.test(pw)) n += 26;
  if (/[0-9]/.test(pw)) n += 10;
  if (/[^A-Za-z0-9]/.test(pw)) n += 33;
  if (/[^\x00-\x7f]/.test(pw)) n += 100;
  return n;
}

function hasSequence(pw: string, minLen = 4): boolean {
  const s = pw.toLowerCase();
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    run = d === 1 || d === -1 ? run + 1 : 1;
    if (run >= minLen) return true;
  }
  return false;
}

function hasKeyboardWalk(pw: string, minLen = 4): boolean {
  const s = pw.toLowerCase();
  for (const row of KEYBOARD_ROWS) {
    for (let i = 0; i + minLen <= row.length; i++) {
      const chunk = row.slice(i, i + minLen);
      if (s.includes(chunk) || s.includes([...chunk].reverse().join(""))) return true;
    }
  }
  return false;
}

function unleet(s: string): string {
  return s
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/0/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/7/g, "t");
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds > 1e3 * 31557600 * 1e6) return "centuries+";
  if (seconds < 1) return "instant";
  const units: [string, number][] = [
    ["year", 31557600],
    ["month", 2629800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [name, size] of units) {
    if (seconds >= size) {
      const v = seconds / size;
      if (name === "year" && v >= 1000) {
        return v >= 1e6 ? `${(v / 1e6).toFixed(0)} million years` : `${Math.round(v / 1000)}k years`;
      }
      const r = Math.round(v);
      return `${r} ${name}${r === 1 ? "" : "s"}`;
    }
  }
  return "instant";
}

const SCENARIOS: { scenario: string; perSecond: number }[] = [
  { scenario: "Online, rate-limited (100/hour)", perSecond: 100 / 3600 },
  { scenario: "Online, no rate limit (10/s)", perSecond: 10 },
  { scenario: "Offline, slow hash (bcrypt, 10k/s)", perSecond: 1e4 },
  { scenario: "Offline, fast hash (MD5/SHA-1, 10B/s)", perSecond: 1e10 },
];

export function analyzePassword(pw: string): PasswordReport {
  const warnings: string[] = [];
  const len = [...pw].length;
  const size = charsetSize(pw);
  let bits = len > 0 && size > 0 ? len * Math.log2(size) : 0;

  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(unleet(pw))) {
    warnings.push("This is one of the most common passwords.");
    bits = Math.min(bits, 4);
  }
  if (len > 0 && new Set(pw).size <= 2) {
    warnings.push("Repeats one or two characters.");
    bits = Math.min(bits, Math.log2(size || 1) + Math.log2(len) + 1);
  } else if (/(.)\1{2,}/.test(pw)) {
    warnings.push("Contains repeated characters (aaa).");
    bits -= 6;
  }
  if (hasSequence(pw)) {
    warnings.push("Contains a sequence (abcd, 1234).");
    bits -= 8;
  }
  if (hasKeyboardWalk(pw)) {
    warnings.push("Contains a keyboard pattern (qwerty, asdf).");
    bits -= 8;
  }
  if (/(19|20)\d{2}/.test(pw)) {
    warnings.push("Contains a year — dates are among the first guesses.");
    bits -= 5;
  }
  for (const word of COMMON_PASSWORDS) {
    if (word.length >= 5 && /^[a-z]+$/.test(word) && unleet(pw).includes(word) && unleet(pw) !== word) {
      warnings.push(`Built around a common word ("${word}").`);
      bits -= 12;
      break;
    }
  }
  if (len > 0 && len < 12) warnings.push("Shorter than 12 characters.");
  if (len > 0 && size <= 26) warnings.push("Uses a single character class; add length or variety.");

  bits = Math.max(0, Math.round(bits * 10) / 10);
  const score: PasswordReport["score"] = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  const label = (["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const)[score];
  // On average an attacker finds it after searching half the space.
  const guesses = Math.pow(2, bits) / 2;
  const crackTimes = SCENARIOS.map(({ scenario, perSecond }) => {
    const seconds = guesses / perSecond;
    return { scenario, seconds, display: formatDuration(seconds) };
  });
  return { bits, score, label, charsetSize: size, warnings, crackTimes };
}
