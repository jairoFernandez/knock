// HTTP security-header audit. Input is raw header text (curl -I, devtools,
// Knock's response view); output is graded findings. Pure, unit-tested.

import type { Finding, Severity } from "./jwt.js";

export type { Finding, Severity };

export interface HeaderLine {
  name: string; // lower-cased
  value: string;
}

/**
 * Parse "Name: value" lines. Skips the status line and blank lines, keeps
 * repeated headers (Set-Cookie) as separate entries, and if several responses
 * are pasted (redirect chain from curl -IL) keeps only the last one.
 */
export function parseHeaderText(text: string): HeaderLine[] {
  let out: HeaderLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^HTTP\/\d(\.\d)?\s+\d{3}/i.test(line)) {
      out = [];
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    out.push({ name, value: line.slice(idx + 1).trim() });
  }
  return out;
}

function get(headers: HeaderLine[], name: string): string | null {
  const h = headers.find((x) => x.name === name);
  return h ? h.value : null;
}

// -------- CSP --------

export type CspPolicy = Map<string, string[]>;

export function parseCsp(value: string): CspPolicy {
  const policy: CspPolicy = new Map();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!policy.has(name)) policy.set(name, tokens.slice(1));
  }
  return policy;
}

function cspFindings(value: string, reportOnly: boolean): Finding[] {
  const f: Finding[] = [];
  const csp = parseCsp(value);
  const scriptSrc = csp.get("script-src") ?? csp.get("default-src");
  const label = reportOnly ? "CSP (report-only)" : "CSP";
  if (!scriptSrc) {
    f.push({ severity: "high", code: "csp-no-script-src", title: `${label} has neither script-src nor default-src`, detail: "Scripts from any origin are allowed." });
  } else {
    const lower = scriptSrc.map((s) => s.toLowerCase());
    const hasNonceOrHash = lower.some((s) => /^'(nonce|sha256|sha384|sha512)-/.test(s));
    const strictDynamic = lower.includes("'strict-dynamic'");
    if (lower.includes("'unsafe-inline'") && !hasNonceOrHash) {
      f.push({ severity: "high", code: "csp-unsafe-inline", title: "script-src allows 'unsafe-inline'", detail: "Inline scripts run, so CSP does not stop XSS. Use nonces or hashes." });
    }
    if (lower.includes("'unsafe-eval'")) {
      f.push({ severity: "medium", code: "csp-unsafe-eval", title: "script-src allows 'unsafe-eval'", detail: "eval() and new Function() can turn injected strings into code." });
    }
    const wild = lower.filter((s) => s === "*" || s === "http:" || s === "https:" || s === "data:" || s === "blob:");
    if (wild.length > 0 && !strictDynamic) {
      f.push({ severity: "high", code: "csp-wildcard", title: `script-src allows ${wild.join(" ")}`, detail: "Scripts can load from any host (or data: URLs), which defeats the policy." });
    }
    if (lower.some((s) => s.startsWith("http://"))) {
      f.push({ severity: "medium", code: "csp-http-source", title: "script-src includes plain http:// sources", detail: "Scripts fetched over HTTP can be swapped in transit." });
    }
  }
  const objectSrc = csp.get("object-src") ?? csp.get("default-src");
  if (!objectSrc || !objectSrc.map((s) => s.toLowerCase()).includes("'none'")) {
    f.push({ severity: "low", code: "csp-object-src", title: "object-src is not 'none'", detail: "Plugins (<object>, <embed>) can be used to bypass script-src." });
  }
  if (!csp.has("base-uri")) {
    f.push({ severity: "low", code: "csp-base-uri", title: "No base-uri", detail: "An injected <base> tag can redirect relative script URLs. Use base-uri 'self' or 'none'." });
  }
  if (reportOnly) {
    f.push({ severity: "medium", code: "csp-report-only", title: "CSP is report-only", detail: "Violations are reported but nothing is blocked." });
  }
  return f;
}

// -------- cookies --------

export interface CookieInfo {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  path: string | null;
  domain: string | null;
}

export function parseSetCookie(value: string): CookieInfo {
  const [pair, ...attrs] = value.split(";");
  const name = pair.split("=")[0].trim();
  const info: CookieInfo = { name, secure: false, httpOnly: false, sameSite: null, path: null, domain: null };
  for (const a of attrs) {
    const [k, ...rest] = a.trim().split("=");
    const key = k.toLowerCase();
    const val = rest.join("=").trim();
    if (key === "secure") info.secure = true;
    else if (key === "httponly") info.httpOnly = true;
    else if (key === "samesite") info.sameSite = val.toLowerCase();
    else if (key === "path") info.path = val;
    else if (key === "domain") info.domain = val;
  }
  return info;
}

const SESSION_COOKIE_RE = /(sess|sid|token|auth|jwt|login|remember|csrf|xsrf|identity)/i;

function cookieFindings(c: CookieInfo): Finding[] {
  const f: Finding[] = [];
  const looksSensitive = SESSION_COOKIE_RE.test(c.name);
  if (!c.secure) {
    f.push({ severity: looksSensitive ? "high" : "medium", code: "cookie-secure", title: `Cookie "${c.name}" lacks Secure`, detail: "It is also sent over plain HTTP, where it can be sniffed." });
  }
  if (!c.httpOnly && looksSensitive && !/(csrf|xsrf)/i.test(c.name)) {
    f.push({ severity: "medium", code: "cookie-httponly", title: `Cookie "${c.name}" lacks HttpOnly`, detail: "JavaScript (and therefore XSS) can read it." });
  }
  if (c.sameSite === null) {
    f.push({ severity: "low", code: "cookie-samesite", title: `Cookie "${c.name}" has no SameSite`, detail: "Browsers default to Lax, but set it explicitly (Lax or Strict)." });
  } else if (c.sameSite === "none" && !c.secure) {
    f.push({ severity: "high", code: "cookie-samesite-none", title: `Cookie "${c.name}" is SameSite=None without Secure`, detail: "Browsers reject it, and it would be sent on every cross-site request." });
  }
  if (c.name.startsWith("__Host-") && (!c.secure || c.path !== "/" || c.domain !== null)) {
    f.push({ severity: "medium", code: "cookie-host-prefix", title: `Cookie "${c.name}" breaks the __Host- prefix rules`, detail: "__Host- cookies need Secure, Path=/ and no Domain; browsers will drop it." });
  } else if (c.name.startsWith("__Secure-") && !c.secure) {
    f.push({ severity: "medium", code: "cookie-secure-prefix", title: `Cookie "${c.name}" uses __Secure- without Secure` });
  }
  return f;
}

// -------- audit --------

export interface HeaderAudit {
  findings: Finding[];
  /** Headers that are set and look right. */
  passed: string[];
  score: number;
  grade: "A+" | "A" | "B" | "C" | "D" | "F";
}

const PENALTY: Record<Severity, number> = { high: 20, medium: 10, low: 4, info: 0 };

export function gradeFor(score: number): HeaderAudit["grade"] {
  if (score >= 100) return "A+";
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

export function auditSecurityHeaders(
  headers: HeaderLine[],
  opts: { https?: boolean } = {},
): HeaderAudit {
  const f: Finding[] = [];
  const passed: string[] = [];
  const https = opts.https ?? true;

  // HSTS
  const hsts = get(headers, "strict-transport-security");
  if (!hsts) {
    if (https) f.push({ severity: "medium", code: "hsts-missing", title: "No Strict-Transport-Security", detail: "The first visit (or a typed http:// URL) can be downgraded. Use max-age=31536000; includeSubDomains." });
  } else {
    const m = /max-age\s*=\s*"?(\d+)/i.exec(hsts);
    const maxAge = m ? Number(m[1]) : 0;
    if (maxAge < 15552000) {
      f.push({ severity: "low", code: "hsts-short", title: `HSTS max-age is ${maxAge}s (< 180 days)`, detail: "Use at least 31536000 (1 year)." });
    } else if (!/includesubdomains/i.test(hsts)) {
      f.push({ severity: "info", code: "hsts-subdomains", title: "HSTS without includeSubDomains" });
      passed.push("Strict-Transport-Security");
    } else {
      passed.push("Strict-Transport-Security");
    }
  }

  // CSP
  const csp = get(headers, "content-security-policy");
  const cspRo = get(headers, "content-security-policy-report-only");
  if (csp) {
    const cf = cspFindings(csp, false);
    f.push(...cf);
    if (!cf.some((x) => x.severity === "high")) passed.push("Content-Security-Policy");
  } else if (cspRo) {
    f.push(...cspFindings(cspRo, true));
  } else {
    f.push({ severity: "high", code: "csp-missing", title: "No Content-Security-Policy", detail: "Nothing limits where scripts load from, so any XSS runs freely." });
  }

  // Framing
  const xfo = get(headers, "x-frame-options");
  const frameAncestors = csp ? parseCsp(csp).get("frame-ancestors") : undefined;
  if (frameAncestors) {
    passed.push("frame-ancestors");
  } else if (!xfo) {
    f.push({ severity: "medium", code: "framing", title: "Page can be framed by any site", detail: "No X-Frame-Options or CSP frame-ancestors: clickjacking is possible. Use frame-ancestors 'none' (or 'self')." });
  } else if (/allow-from/i.test(xfo)) {
    f.push({ severity: "medium", code: "xfo-allow-from", title: "X-Frame-Options ALLOW-FROM is ignored by modern browsers", detail: "Use CSP frame-ancestors instead." });
  } else if (!/^(deny|sameorigin)$/i.test(xfo)) {
    f.push({ severity: "medium", code: "xfo-invalid", title: `Invalid X-Frame-Options "${xfo}"` });
  } else {
    passed.push("X-Frame-Options");
  }

  // nosniff
  const xcto = get(headers, "x-content-type-options");
  if (!xcto || xcto.toLowerCase() !== "nosniff") {
    f.push({ severity: "low", code: "nosniff", title: "X-Content-Type-Options is not nosniff", detail: "Browsers may guess content types and run uploads as scripts." });
  } else {
    passed.push("X-Content-Type-Options");
  }

  // Referrer-Policy
  const rp = get(headers, "referrer-policy");
  if (!rp) {
    f.push({ severity: "low", code: "referrer-missing", title: "No Referrer-Policy", detail: "Use strict-origin-when-cross-origin (or stricter) so URLs with tokens don't leak to other sites." });
  } else if (/unsafe-url|no-referrer-when-downgrade/i.test(rp)) {
    f.push({ severity: "low", code: "referrer-weak", title: `Referrer-Policy "${rp}" leaks full URLs cross-origin` });
  } else {
    passed.push("Referrer-Policy");
  }

  // Permissions-Policy
  if (!get(headers, "permissions-policy")) {
    f.push({ severity: "info", code: "permissions-missing", title: "No Permissions-Policy", detail: "Lets you switch off camera, mic, geolocation, etc. for the page and its iframes." });
  } else {
    passed.push("Permissions-Policy");
  }

  // CORS
  const acao = get(headers, "access-control-allow-origin");
  const acac = get(headers, "access-control-allow-credentials");
  if (acao === "*" && acac?.toLowerCase() === "true") {
    f.push({ severity: "high", code: "cors-wildcard-credentials", title: "CORS: Allow-Origin * with Allow-Credentials true", detail: "Browsers refuse this combination; a server that 'fixes' it by echoing the Origin lets any site read authenticated responses." });
  } else if (acao === "null") {
    f.push({ severity: "medium", code: "cors-null", title: "CORS allows the \"null\" origin", detail: "Sandboxed iframes and file:// pages send Origin: null, so any site can obtain it." });
  } else if (acao === "*") {
    f.push({ severity: "info", code: "cors-wildcard", title: "CORS allows any origin", detail: "Fine for public data; make sure nothing private is served here." });
  }

  // Cookies
  for (const h of headers.filter((x) => x.name === "set-cookie")) {
    f.push(...cookieFindings(parseSetCookie(h.value)));
  }

  // Disclosure
  const server = get(headers, "server");
  if (server && /\d/.test(server)) {
    f.push({ severity: "low", code: "server-version", title: `Server header reveals a version: "${server}"`, detail: "Makes it easy to match known CVEs." });
  }
  for (const n of ["x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-generator"]) {
    const v = get(headers, n);
    if (v) f.push({ severity: "low", code: `disclosure-${n}`, title: `${n} reveals the stack: "${v}"` });
  }

  const xxss = get(headers, "x-xss-protection");
  if (xxss && !/^0/.test(xxss)) {
    f.push({ severity: "info", code: "x-xss-protection", title: "X-XSS-Protection is deprecated", detail: "The filter it enables caused vulnerabilities; set it to 0 or remove it and rely on CSP." });
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);
  const score = Math.max(0, 100 - f.reduce((n, x) => n + PENALTY[x.severity], 0));
  return { findings: f, passed, score, grade: gradeFor(score) };
}
