import test from "node:test";
import assert from "node:assert/strict";

import { base32ToBytes, bytesToBase32, shannonEntropy } from "../.test-dist/src/security/encoding.js";
import { parseHeaderText, auditSecurityHeaders, parseCsp, parseSetCookie, gradeFor } from "../.test-dist/src/security/headers.js";
import { scanSecrets, redact } from "../.test-dist/src/security/secrets.js";
import { hotp, totp, parseTotpInput, secondsRemaining } from "../.test-dist/src/security/totp.js";
import { analyzePassword, formatDuration } from "../.test-dist/src/security/password.js";

const ascii = (s) => new TextEncoder().encode(s);

// -------- base32 --------

test("base32 matches RFC 4648 vectors", () => {
  assert.equal(bytesToBase32(ascii("foobar")), "MZXW6YTBOI");
  assert.deepEqual(base32ToBytes("mzxw6ytboi======"), ascii("foobar"));
  assert.deepEqual(base32ToBytes("MZXW 6YTB-OI"), ascii("foobar"));
  assert.throws(() => base32ToBytes("MZ1"), /invalid base32/);
});

test("entropy of random-looking strings is higher", () => {
  assert.ok(shannonEntropy("aaaaaaaa") < 1);
  assert.ok(shannonEntropy("k8$Zq2!vP0xR") > 3.4);
});

// -------- TOTP / HOTP --------

test("HOTP matches RFC 4226 vectors", async () => {
  const secret = ascii("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314"];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(await hotp(secret, i), expected[i]);
  }
});

test("TOTP matches RFC 6238 vectors (SHA1/256/512, 8 digits)", async () => {
  const cases = [
    ["SHA1", "12345678901234567890", 59, "94287082"],
    ["SHA256", "12345678901234567890123456789012", 59, "46119246"],
    ["SHA512", "1234567890123456789012345678901234567890123456789012345678901234", 59, "90693936"],
    ["SHA1", "12345678901234567890", 1111111109, "07081804"],
    ["SHA1", "12345678901234567890", 2000000000, "69279037"],
  ];
  for (const [algorithm, s, t, code] of cases) {
    const cfg = { secret: ascii(s), algorithm, digits: 8, period: 30 };
    assert.equal(await totp(cfg, t * 1000), code, `${algorithm} @${t}`);
  }
});

test("parses otpauth URIs and bare secrets", () => {
  const cfg = parseTotpInput(
    "otpauth://totp/ACME%20Co:jane@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60",
  );
  assert.equal(cfg.issuer, "ACME Co");
  assert.equal(cfg.account, "jane@example.com");
  assert.equal(cfg.algorithm, "SHA256");
  assert.equal(cfg.digits, 8);
  assert.equal(cfg.period, 60);
  const bare = parseTotpInput("jbsw y3dp ehpk 3pxp");
  assert.equal(bare.digits, 6);
  assert.equal(bare.secret.length, 10);
  assert.throws(() => parseTotpInput("otpauth://hotp/x?secret=JBSWY3DP"), /only TOTP/);
});

test("seconds remaining counts down within the period", () => {
  assert.equal(secondsRemaining(0, 30), 30);
  assert.equal(secondsRemaining(29_000, 30), 1);
});

// -------- headers --------

test("parses curl -i output, keeping only the final response", () => {
  const h = parseHeaderText(
    "HTTP/1.1 301 Moved\nLocation: /x\n\nHTTP/2 200\ncontent-type: text/html\nSet-Cookie: a=1\nset-cookie: b=2\n\n<html>",
  );
  assert.deepEqual(h.map((x) => x.name), ["content-type", "set-cookie", "set-cookie"]);
});

test("a hardened response grades A+", () => {
  const h = parseHeaderText(`
strict-transport-security: max-age=63072000; includeSubDomains; preload
content-security-policy: default-src 'self'; script-src 'self' 'nonce-abc'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
permissions-policy: camera=()
set-cookie: __Host-session=abc; Path=/; Secure; HttpOnly; SameSite=Lax
`);
  const a = auditSecurityHeaders(h);
  assert.deepEqual(a.findings, []);
  assert.equal(a.grade, "A+");
});

test("a bare response gets an F with the key gaps called out", () => {
  const a = auditSecurityHeaders(parseHeaderText("content-type: text/html\nserver: nginx/1.18.0\nx-powered-by: Express"));
  const c = a.findings.map((f) => f.code);
  for (const code of ["csp-missing", "hsts-missing", "framing", "nosniff", "server-version", "disclosure-x-powered-by"]) {
    assert.ok(c.includes(code), code);
  }
  assert.ok(["D", "F"].includes(a.grade));
});

test("CSP weaknesses are detected", () => {
  const a = auditSecurityHeaders(
    parseHeaderText("content-security-policy: script-src 'self' 'unsafe-inline' 'unsafe-eval' https:"),
  );
  const c = a.findings.map((f) => f.code);
  assert.ok(c.includes("csp-unsafe-inline"));
  assert.ok(c.includes("csp-unsafe-eval"));
  assert.ok(c.includes("csp-wildcard"));
  assert.ok(c.includes("csp-object-src"));
});

test("'unsafe-inline' next to a nonce is not flagged (CSP2+ ignores it)", () => {
  const a = auditSecurityHeaders(parseHeaderText("content-security-policy: script-src 'nonce-x' 'unsafe-inline'"));
  assert.ok(!a.findings.some((f) => f.code === "csp-unsafe-inline"));
});

test("report-only CSP does not count as protection", () => {
  const a = auditSecurityHeaders(parseHeaderText("content-security-policy-report-only: default-src 'self'"));
  assert.ok(a.findings.some((f) => f.code === "csp-report-only"));
});

test("cookie flags and CORS misconfigurations", () => {
  const a = auditSecurityHeaders(
    parseHeaderText(
      "set-cookie: sessionid=1; SameSite=None\nset-cookie: __Host-x=1; Secure; Path=/app\naccess-control-allow-origin: *\naccess-control-allow-credentials: true",
    ),
  );
  const c = a.findings.map((f) => f.code);
  assert.ok(c.includes("cookie-secure"));
  assert.ok(c.includes("cookie-httponly"));
  assert.ok(c.includes("cookie-samesite-none"));
  assert.ok(c.includes("cookie-host-prefix"));
  assert.ok(c.includes("cors-wildcard-credentials"));
});

test("HSTS is not demanded for plain-http responses", () => {
  const a = auditSecurityHeaders([], { https: false });
  assert.ok(!a.findings.some((f) => f.code === "hsts-missing"));
});

test("parseCsp and parseSetCookie basics", () => {
  assert.deepEqual(parseCsp("default-src 'self'; img-src *").get("img-src"), ["*"]);
  const c = parseSetCookie("id=a=b; Secure; HttpOnly; SameSite=Strict; Path=/");
  assert.equal(c.name, "id");
  assert.equal(c.sameSite, "strict");
  assert.equal(c.path, "/");
  assert.equal(gradeFor(70), "C");
});

// -------- secrets --------

test("finds provider keys with line/column and redacts them", () => {
  const text = [
    "const a = 1;",
    'AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"',
    "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
    // Assembled at runtime so the fixture isn't a literal key-shaped string in the repo.
    `stripe = ${["sk", "live", "51HabcdefGHIJKLmnopQRSTuv"].join("_")}`,
  ].join("\n");
  const f = scanSecrets(text);
  const ids = f.map((x) => x.ruleId);
  assert.ok(ids.includes("aws-access-key"));
  assert.ok(ids.includes("github-token"));
  assert.ok(ids.includes("stripe-secret"));
  const aws = f.find((x) => x.ruleId === "aws-access-key");
  assert.equal(aws.line, 2);
  assert.equal(aws.column, 20);
  assert.ok(!aws.redacted.includes("IOSFODNN7EXAM"));
});

test("finds private keys, JWTs and credentials in URLs", () => {
  const text = `
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA
-----END RSA PRIVATE KEY-----
Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U
DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/app`;
  const ids = scanSecrets(text).map((x) => x.ruleId);
  assert.ok(ids.includes("private-key"));
  assert.ok(ids.includes("jwt"));
  assert.ok(ids.includes("url-credentials"));
});

test("generic assignments need high entropy and skip placeholders", () => {
  const f = scanSecrets(
    'API_SECRET = "Zx8#kP2!qL9@vM4$"\npassword: changeme\nCLIENT_SECRET=${CLIENT_SECRET}\nauth_token = "aaaaaaaaaaaaaaaa"',
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "generic");
  assert.equal(f[0].line, 1);
});

test("a specific match is not reported twice as generic", () => {
  const f = scanSecrets("GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
  assert.deepEqual(f.map((x) => x.ruleId), ["github-token"]);
});

test("clean text has no findings", () => {
  assert.deepEqual(scanSecrets("hello world\nconst x = getConfig('token');"), []);
});

test("redact hides the middle", () => {
  assert.equal(redact("abcd"), "••••");
  const r = redact("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
  assert.ok(r.startsWith("ghp_aB") && r.endsWith("456789"));
});

// -------- passwords --------

test("common passwords are very weak regardless of length", () => {
  for (const pw of ["password", "P@ssw0rd", "qwerty123", "123456789"]) {
    assert.equal(analyzePassword(pw).score, 0, pw);
  }
});

test("patterns lower the estimate", () => {
  const seq = analyzePassword("Abcdefgh12345!");
  assert.ok(seq.warnings.some((w) => /sequence/.test(w)));
  const year = analyzePassword("Summer2024!x");
  assert.ok(year.warnings.some((w) => /year/.test(w)));
});

test("long random passphrases are very strong", () => {
  const r = analyzePassword("v9#Lq!2mZ@8wR$4tKp&7");
  assert.equal(r.score, 4);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.crackTimes[3].display, "centuries+");
});

test("empty input is harmless", () => {
  const r = analyzePassword("");
  assert.equal(r.bits, 0);
  assert.equal(r.score, 0);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(0.2), "instant");
  assert.equal(formatDuration(90), "2 minutes");
  assert.equal(formatDuration(86400 * 3), "3 days");
});
