import { useMemo, useState } from "react";
import { scanSecrets } from "../security/secrets";
import { LocalOnlyNote, SeverityChip } from "./securityUi";

export function SecretScanTool() {
  // Deliberately not persisted: the input is expected to contain secrets.
  const [text, setText] = useState("");
  const [minEntropy, setMinEntropy] = useState(3.5);

  const findings = useMemo(() => scanSecrets(text, { minEntropy }), [text, minEntropy]);

  return (
    <>
      <label className="tools-label">Text, logs, config or code</label>
      <textarea
        className="tools-textarea tools-textarea-tall"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Paste a .env, a log, a config file or a diff to look for leaked keys and tokens."}
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>
          Generic detection threshold: {minEntropy.toFixed(1)} bits/char
        </span>
        <input
          type="range"
          min={2.5}
          max={5}
          step={0.1}
          value={minEntropy}
          onChange={(e) => setMinEntropy(Number(e.target.value))}
          aria-label="Entropy threshold"
        />
      </div>
      {text && findings.length === 0 && <div className="sec-ok">✓ No secrets found.</div>}
      {findings.length > 0 && (
        <>
          <div className="tools-output-header">
            <span>
              {findings.length} possible secret{findings.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="sec-findings">
            {findings.map((f) => (
              <li key={`${f.start}-${f.ruleId}`} className={`sec-finding sec-border-${f.severity}`}>
                <div className="sec-finding-head">
                  <SeverityChip severity={f.severity} />
                  <span className="sec-finding-title">{f.name}</span>
                  <span className="sec-finding-loc">
                    line {f.line}:{f.column}
                  </span>
                </div>
                <div className="sec-finding-detail">
                  <code>{f.redacted}</code>
                  <span className="sec-finding-loc"> · entropy {f.entropy}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="tools-warning">
            Treat anything found here as compromised if it was ever committed or shared: rotate it, then remove it.
          </div>
        </>
      )}
      <LocalOnlyNote />
    </>
  );
}
