// Leaked-secret scanner for pasted text, logs and config. Pure, unit-tested.

import { shannonEntropy } from "./encoding.js";
import type { Severity } from "./jwt.js";

export interface SecretRule {
  id: string;
  name: string;
  severity: Severity;
  re: RegExp;
  /** Capture group holding the secret itself (default: whole match). */
  group?: number;
}

// Specific provider formats first; overlapping generic hits are dropped.
export const SECRET_RULES: SecretRule[] = [
  { id: "private-key", name: "Private key", severity: "high", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "aws-access-key", name: "AWS access key ID", severity: "high", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: "aws-secret-key", name: "AWS secret access key", severity: "high", re: /aws.{0,20}?(?:secret|private).{0,20}?['"=:\s]+([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, group: 1 },
  { id: "github-token", name: "GitHub token", severity: "high", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: "github-pat", name: "GitHub fine-grained token", severity: "high", re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g },
  { id: "gitlab-token", name: "GitLab token", severity: "high", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "slack-token", name: "Slack token", severity: "high", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: "slack-webhook", name: "Slack webhook URL", severity: "medium", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g },
  { id: "stripe-secret", name: "Stripe secret key", severity: "high", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { id: "stripe-test", name: "Stripe test key", severity: "low", re: /\b(?:sk|rk)_test_[A-Za-z0-9]{16,}\b/g },
  { id: "anthropic-key", name: "Anthropic API key", severity: "high", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", name: "OpenAI API key", severity: "high", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-proj-[A-Za-z0-9_-]{40,}/g },
  { id: "google-api-key", name: "Google API key", severity: "high", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "sendgrid-key", name: "SendGrid API key", severity: "high", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: "twilio-key", name: "Twilio API key", severity: "high", re: /\bSK[0-9a-f]{32}\b/g },
  { id: "npm-token", name: "npm token", severity: "high", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "azure-storage", name: "Azure storage account key", severity: "high", re: /AccountKey=([A-Za-z0-9+/=]{80,})/g, group: 1 },
  { id: "jwt", name: "JSON Web Token", severity: "medium", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "url-credentials", name: "Credentials in URL", severity: "high", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s:/@'"]{3,})@[^\s'"]+/gi, group: 1 },
  { id: "bearer", name: "Bearer token", severity: "medium", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
];

/** key = value assignments whose name says "secret" and whose value looks random. */
const GENERIC_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)\s*["']?\s*[:=]\s*["']?([^\s"'`,;]{12,})/gi;

const PLACEHOLDER_RE = /^(x+|\*+|<.*>|\$\{.*\}|\{\{.*\}\}|%.*%|changeme|your[_-].*|example.*|dummy.*|test.*|null|none|true|false|undefined|process\.env.*)$/i;

export interface SecretFinding {
  ruleId: string;
  name: string;
  severity: Severity;
  line: number; // 1-based
  column: number; // 1-based
  start: number; // offset in text
  end: number;
  /** The secret with its middle hidden. */
  redacted: string;
  entropy: number;
}

export function redact(secret: string): string {
  const s = secret.replace(/\s+/g, " ");
  if (s.length <= 8) return "•".repeat(s.length);
  if (s.startsWith("-----BEGIN")) return s.slice(0, s.indexOf("-----", 10) + 5) + " … (redacted)";
  const keep = Math.min(6, Math.floor(s.length / 4));
  return `${s.slice(0, keep)}${"•".repeat(Math.min(12, s.length - keep * 2))}${s.slice(-keep)}`;
}

function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

export function scanSecrets(text: string, opts: { minEntropy?: number } = {}): SecretFinding[] {
  const minEntropy = opts.minEntropy ?? 3.5;
  const out: SecretFinding[] = [];
  const overlaps = (s: number, e: number) => out.some((f) => s < f.end && e > f.start);

  const push = (rule: { id: string; name: string; severity: Severity }, value: string, start: number) => {
    const end = start + value.length;
    if (overlaps(start, end)) return;
    const { line, column } = lineCol(text, start);
    out.push({
      ruleId: rule.id,
      name: rule.name,
      severity: rule.severity,
      line,
      column,
      start,
      end,
      redacted: redact(value),
      entropy: Math.round(shannonEntropy(value) * 100) / 100,
    });
  };

  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = rule.group ? m[rule.group] : m[0];
      if (!value || m.index === undefined) continue;
      const start = m.index + (rule.group ? m[0].indexOf(value) : 0);
      push(rule, value, start);
    }
  }

  for (const m of text.matchAll(GENERIC_ASSIGNMENT)) {
    const value = m[2];
    if (m.index === undefined || PLACEHOLDER_RE.test(value)) continue;
    if (shannonEntropy(value) < minEntropy) continue;
    const start = m.index + m[0].lastIndexOf(value);
    push({ id: "generic", name: `High-entropy value for "${m[1]}"`, severity: "medium" }, value, start);
  }

  return out.sort((a, b) => a.start - b.start);
}
