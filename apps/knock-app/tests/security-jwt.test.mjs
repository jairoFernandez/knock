import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

import {
  decodeJwt,
  verifyJwt,
  signJwt,
  auditJwt,
  findWeakHmacSecret,
  checkExpectations,
  encodeSegment,
} from "../.test-dist/src/security/jwt.js";
import {
  generateKeyPair,
  jwkThumbprint,
  pkcs1PublicToSpki,
  pkcs1PrivateToPkcs8,
  parsePem,
  selectJwk,
  algSpec,
} from "../.test-dist/src/security/keys.js";

// jwt.io's sample token, signed with "your-256-bit-secret".
const JWT_IO =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// -------- decode --------

test("decodes header, payload and alg", () => {
  const r = decodeJwt(JWT_IO);
  assert.equal(r.ok, true);
  assert.equal(r.jwt.alg, "HS256");
  assert.equal(r.jwt.payload.name, "John Doe");
});

test("accepts a pasted Authorization header value", () => {
  assert.equal(decodeJwt(`Bearer ${JWT_IO}`).ok, true);
});

test("explains JWE and malformed tokens", () => {
  assert.match(decodeJwt("a.b.c.d.e").error, /JWE/);
  assert.match(decodeJwt("abc.def").error, /3 dot-separated/);
  assert.match(decodeJwt("!!!.e30.").error, /Header/);
});

// -------- HMAC --------

test("verifies an HS256 token with the right secret", async () => {
  const r = await verifyJwt(JWT_IO, { secret: "your-256-bit-secret" });
  assert.equal(r.status, "valid");
});

test("rejects an HS256 token with the wrong secret", async () => {
  const r = await verifyJwt(JWT_IO, { secret: "nope" });
  assert.equal(r.status, "invalid");
});

test("asks for a key instead of failing when none is given", async () => {
  assert.equal((await verifyJwt(JWT_IO, {})).status, "needs-key");
});

test("verifying never alters the token", async () => {
  // Regression: the old tool re-signed pasted tokens with the stored secret.
  const before = JWT_IO;
  await verifyJwt(before, { secret: "something-else" });
  assert.equal(before, JWT_IO);
});

test("finds a token signed with a well-known secret", async () => {
  assert.equal(await findWeakHmacSecret(JWT_IO), "your-256-bit-secret");
});

test("does not flag a strong secret", async () => {
  const token = await signJwt('{"alg":"HS256"}', '{"sub":"1"}', {
    secret: "k3Y-9f8a7sd6f5a4s3d2f1a0s9d8f7a6s5d4",
  });
  assert.equal(await findWeakHmacSecret(token), null);
});

test("supports base64 secrets", async () => {
  const token = await signJwt('{"alg":"HS512"}', '{"a":1}', { secret: "c2VjcmV0LWJ5dGVz", secretIsBase64: true });
  assert.equal((await verifyJwt(token, { secret: "secret-bytes" })).status, "valid");
});

// -------- alg none --------

test("alg none is reported as unsigned, and invalid if it carries a signature", async () => {
  const unsigned = `${encodeSegment('{"alg":"none"}')}.${encodeSegment('{"a":1}')}.`;
  assert.equal((await verifyJwt(unsigned, {})).status, "unsigned");
  assert.equal((await verifyJwt(`${unsigned}abc`, {})).status, "invalid");
});

// -------- asymmetric round trips --------

for (const [kind, alg] of [
  ["RSA-2048", "RS256"],
  ["RSA-2048", "PS256"],
  ["P-256", "ES256"],
  ["P-384", "ES384"],
  ["P-521", "ES512"],
  ["Ed25519", "EdDSA"],
]) {
  test(`${alg}: sign with private PEM, verify with public PEM and JWK`, async () => {
    const kp = await generateKeyPair(kind);
    const token = await signJwt(JSON.stringify({ alg, kid: kp.kid }), '{"sub":"42"}', {
      keyText: kp.privatePem,
    });
    assert.equal((await verifyJwt(token, { keyText: kp.publicPem })).status, "valid");
    // The generated JWK carries alg for its default; strip it so PS256 can reuse an RSA key.
    const jwk = { ...kp.publicJwk };
    delete jwk.alg;
    assert.equal((await verifyJwt(token, { keyText: JSON.stringify(jwk) })).status, "valid");
    // A private key also verifies (its public half is derived).
    assert.equal((await verifyJwt(token, { keyText: kp.privatePem })).status, "valid");
  });
}

test("a tampered payload fails verification", async () => {
  const kp = await generateKeyPair("P-256");
  const token = await signJwt('{"alg":"ES256"}', '{"role":"user"}', { keyText: kp.privatePem });
  const [h, , s] = token.split(".");
  const forged = `${h}.${encodeSegment('{"role":"admin"}')}.${s}`;
  assert.equal((await verifyJwt(forged, { keyText: kp.publicPem })).status, "invalid");
});

test("signing with a public key is refused", async () => {
  const kp = await generateKeyPair("P-256");
  await assert.rejects(signJwt('{"alg":"ES256"}', "{}", { keyText: kp.publicPem }), /private key/);
});

test("a JWK for another alg is reported, not silently used", async () => {
  const kp = await generateKeyPair("P-256");
  const token = await signJwt('{"alg":"ES256"}', "{}", { keyText: kp.privatePem });
  const wrong = { ...kp.publicJwk, alg: "ES384" };
  const r = await verifyJwt(token, { keyText: JSON.stringify(wrong) });
  assert.equal(r.status, "error");
  assert.match(r.message, /ES384/);
});

// -------- JWKS --------

test("picks the JWKS key by kid", async () => {
  const a = await generateKeyPair("P-256");
  const b = await generateKeyPair("P-256");
  const token = await signJwt(JSON.stringify({ alg: "ES256", kid: b.kid }), "{}", { keyText: b.privatePem });
  const jwks = JSON.stringify({ keys: [a.publicJwk, b.publicJwk] });
  assert.equal((await verifyJwt(token, { keyText: jwks })).status, "valid");
});

test("explains a kid that is not in the JWKS", async () => {
  const a = await generateKeyPair("P-256");
  const token = await signJwt('{"alg":"ES256","kid":"missing"}', "{}", { keyText: a.privatePem });
  const r = await verifyJwt(token, { keyText: JSON.stringify({ keys: [a.publicJwk] }) });
  assert.equal(r.status, "error");
  assert.match(r.message, /missing/);
});

test("selectJwk refuses to guess between several keys without kid", () => {
  const keys = [{ kty: "EC", kid: "1" }, { kty: "EC", kid: "2" }];
  assert.throws(() => selectJwk(keys, "ES256"), /several keys/);
  assert.equal(selectJwk([{ kty: "RSA" }, { kty: "EC", kid: "x" }], "ES256").kid, "x");
});

// -------- PEM flavours --------

test("accepts PKCS#1 RSA keys (BEGIN RSA PUBLIC/PRIVATE KEY)", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1Pub = publicKey.export({ type: "pkcs1", format: "pem" });
  const pkcs1Priv = privateKey.export({ type: "pkcs1", format: "pem" });
  const token = await signJwt('{"alg":"RS256"}', '{"a":1}', { keyText: pkcs1Priv });
  assert.equal((await verifyJwt(token, { keyText: pkcs1Pub })).status, "valid");
});

test("PKCS#1 → SPKI/PKCS#8 wrapping matches Node's own encoding", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1Pub = publicKey.export({ type: "pkcs1", format: "der" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  assert.deepEqual(Buffer.from(pkcs1PublicToSpki(new Uint8Array(pkcs1Pub))), spki);
  const pkcs1Priv = privateKey.export({ type: "pkcs1", format: "der" });
  const wrapped = Buffer.from(pkcs1PrivateToPkcs8(new Uint8Array(pkcs1Priv)));
  const roundTrip = createPrivateKey({ key: wrapped, format: "der", type: "pkcs8" });
  assert.deepEqual(roundTrip.export({ type: "pkcs1", format: "der" }), pkcs1Priv);
});

test("signs with a SEC1 EC key and verifies with an X.509 certificate", async () => {
  const token = await signJwt('{"alg":"ES256"}', '{"sub":"cert"}', {
    keyText: fixture("ec-p256-sec1-key.pem"),
  });
  const r = await verifyJwt(token, { keyText: fixture("ec-p256-cert.pem") });
  assert.equal(r.status, "valid", r.message);
});

test("parsePem ignores surrounding text", () => {
  const pem = createPublicKey(createPrivateKey(fixture("ec-p256-sec1-key.pem"))).export({ type: "spki", format: "pem" });
  const parsed = parsePem(`some log line\n${pem}\ntrailing`);
  assert.equal(parsed.label, "PUBLIC KEY");
});

test("RFC 7638 JWK thumbprint example", async () => {
  const jwk = {
    kty: "RSA",
    n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    e: "AQAB",
    alg: "RS256",
    kid: "2011-04-29",
  };
  assert.equal(await jwkThumbprint(jwk), "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
});

test("algSpec maps every JWS alg", () => {
  assert.equal(algSpec("ES512").curve, "P-521");
  assert.equal(algSpec("PS384").family, "pss");
  assert.equal(algSpec("HS256").hashBytes, 32);
  assert.equal(algSpec("XYZ"), null);
});

// -------- audit --------

const NOW = Date.UTC(2026, 0, 1);
const nowSec = NOW / 1000;
const codes = (findings) => findings.map((f) => f.code);

test("audit: alg none and missing exp", () => {
  const f = auditJwt({ alg: "none" }, { sub: "1" }, { now: NOW });
  assert.ok(codes(f).includes("alg-none"));
  assert.ok(codes(f).includes("no-exp"));
  assert.equal(f[0].severity, "high");
});

test("audit: header key-injection vectors", () => {
  const f = auditJwt(
    { alg: "RS256", jwk: { kty: "RSA" }, jku: "https://evil.example/jwks", kid: "../../dev/null" },
    { exp: nowSec + 60, iss: "a", aud: "b" },
    { now: NOW },
  );
  assert.ok(codes(f).includes("embedded-jwk"));
  assert.ok(codes(f).includes("remote-key-jku"));
  assert.ok(codes(f).includes("kid-injection"));
});

test("audit: weak, short and confused HMAC secrets", () => {
  const base = [{ alg: "HS256" }, { exp: nowSec + 60, iss: "a", aud: "b" }];
  assert.ok(codes(auditJwt(...base, { now: NOW, secret: "secret" })).includes("secret-common"));
  assert.ok(codes(auditJwt(...base, { now: NOW, secret: "short-but-unique" })).includes("secret-short"));
  assert.ok(
    codes(auditJwt(...base, { now: NOW, secret: "-----BEGIN PUBLIC KEY-----\nabc" })).includes("alg-confusion"),
  );
  assert.ok(codes(auditJwt(...base, { now: NOW, crackedSecret: "secret" })).includes("secret-cracked"));
  assert.ok(
    !codes(auditJwt(...base, { now: NOW, secret: "x".repeat(32) + "unique-and-long" })).some((c) =>
      c.startsWith("secret"),
    ),
  );
});

test("audit: lifetime, sensitive data and missing iss/aud", () => {
  const f = auditJwt(
    { alg: "ES256" },
    { iat: nowSec, exp: nowSec + 90 * 86400, user: { password: "x" } },
    { now: NOW },
  );
  const c = codes(f);
  assert.ok(c.includes("long-lived"));
  assert.ok(c.includes("sensitive-data"));
  assert.ok(c.includes("no-iss"));
  assert.ok(c.includes("no-aud"));
});

test("audit: a well-formed token has no high/medium findings", () => {
  const f = auditJwt(
    { alg: "ES256", kid: "abc" },
    { iss: "https://id.example", aud: "api", iat: nowSec, exp: nowSec + 900 },
    { now: NOW },
  );
  assert.deepEqual(f.filter((x) => x.severity === "high" || x.severity === "medium"), []);
});

// -------- expectations --------

test("checks iss, aud (string or array), exp and nbf with leeway", () => {
  const payload = { iss: "a", aud: ["x", "y"], exp: nowSec - 10, nbf: nowSec + 10 };
  const r = checkExpectations(payload, { iss: "a", aud: "y", now: NOW });
  assert.deepEqual(r.map((x) => [x.claim, x.ok]), [["iss", true], ["aud", true], ["exp", false], ["nbf", false]]);
  const lenient = checkExpectations(payload, { now: NOW, leeway: 30 });
  assert.deepEqual(lenient.map((x) => x.ok), [true, true]);
  assert.equal(checkExpectations({ iss: "b" }, { iss: "a", now: NOW })[0].ok, false);
});
