import type { Finding, Severity } from "../security/jwt";

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export function SeverityChip({ severity }: { severity: Severity }) {
  return <span className={`sec-chip sec-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

export function FindingsList({
  findings,
  empty = "No issues found.",
}: {
  findings: Finding[];
  empty?: string;
}) {
  if (findings.length === 0) {
    return <div className="sec-ok">✓ {empty}</div>;
  }
  return (
    <ul className="sec-findings">
      {findings.map((f, i) => (
        <li key={`${f.code}-${i}`} className={`sec-finding sec-border-${f.severity}`}>
          <div className="sec-finding-head">
            <SeverityChip severity={f.severity} />
            <span className="sec-finding-title">{f.title}</span>
          </div>
          {f.detail && <div className="sec-finding-detail">{f.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

export function SeveritySummary({ findings }: { findings: Finding[] }) {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return (
    <span className="sec-summary">
      {(["high", "medium", "low"] as Severity[])
        .filter((s) => counts[s] > 0)
        .map((s) => (
          <span key={s} className={`sec-count sec-${s}`}>
            {counts[s]} {s}
          </span>
        ))}
    </span>
  );
}

/** Reminder shown on tools that handle secrets: nothing is stored or sent. */
export function LocalOnlyNote({ children }: { children?: React.ReactNode }) {
  return (
    <div className="tools-hint sec-local">
      🔒 {children ?? "Runs locally. Nothing you paste here is saved or sent anywhere."}
    </div>
  );
}
