import { useMemo, useState } from "react";
import { analyzePassword } from "../security/password";
import { LocalOnlyNote } from "./securityUi";

const SCORE_TONE = ["bad", "bad", "warn", "ok", "ok"] as const;

export function PasswordTool() {
  // Never persisted.
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const report = useMemo(() => (pw ? analyzePassword(pw) : null), [pw]);

  return (
    <>
      <div className="tools-output-header">
        <span>Password</span>
        <label className="tools-checkbox">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          show
        </label>
      </div>
      <input
        type={show ? "text" : "password"}
        className="tools-input"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="Type a password to estimate its strength"
        spellCheck={false}
        autoComplete="off"
      />
      {report && (
        <>
          <div className="sec-meter" aria-label={`Strength ${report.label}`}>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={i <= report.score ? `on ${SCORE_TONE[report.score]}` : ""} />
            ))}
          </div>
          <div className="sec-meter-label">
            <strong className={SCORE_TONE[report.score]}>{report.label}</strong>
            <span>
              ~{report.bits} bits · {[...pw].length} chars · charset {report.charsetSize}
            </span>
          </div>
          {report.warnings.length > 0 && (
            <ul className="sec-warnings">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <table className="tools-table sec-crack">
            <thead>
              <tr>
                <th>Attack</th>
                <th>Time to crack</th>
              </tr>
            </thead>
            <tbody>
              {report.crackTimes.map((c) => (
                <tr key={c.scenario}>
                  <td>{c.scenario}</td>
                  <td>{c.display}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tools-hint">
            Estimate based on length, character set and common patterns. A random passphrase of 4+ words or 16+
            mixed characters is a good target; reuse across sites matters more than any score.
          </div>
        </>
      )}
      <LocalOnlyNote />
    </>
  );
}
