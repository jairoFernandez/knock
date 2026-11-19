import { useMemo } from "react";
import { auditSecurityHeaders, parseHeaderText } from "../security/headers";
import { usePersistedField } from "./shared";
import { FindingsList, SeveritySummary } from "./securityUi";

const SAMPLE = `HTTP/2 200
content-type: text/html; charset=utf-8
server: nginx/1.18.0
x-powered-by: Express
set-cookie: sessionid=abc123; Path=/
access-control-allow-origin: *`;

export function SecurityHeadersTool() {
  const [text, setText] = usePersistedField<string>("knock.tools.secheaders.input", "");
  const [https, setHttps] = usePersistedField<boolean>("knock.tools.secheaders.https", true);

  const headers = useMemo(() => parseHeaderText(text), [text]);
  const audit = useMemo(() => (headers.length ? auditSecurityHeaders(headers, { https }) : null), [headers, https]);

  return (
    <>
      <div className="tools-output-header">
        <span>Response headers</span>
        <span className="tools-row">
          <label className="tools-checkbox">
            <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} />
            served over HTTPS
          </label>
          {!text && (
            <button className="tools-copy" onClick={() => setText(SAMPLE)}>
              Sample
            </button>
          )}
        </span>
      </div>
      <textarea
        className="tools-textarea tools-textarea-tall"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Paste headers from curl -I, devtools or a Knock response:\n\nstrict-transport-security: max-age=31536000\ncontent-security-policy: default-src 'self'\n…"}
        spellCheck={false}
      />
      {text && headers.length === 0 && <div className="tools-error">No "Name: value" header lines found.</div>}
      {audit && (
        <>
          <div className="sec-grade-row">
            <span className={`sec-grade sec-grade-${audit.grade.replace("+", "plus")}`}>{audit.grade}</span>
            <div className="sec-grade-meta">
              <div>
                Score {audit.score}/100 · {headers.length} headers
              </div>
              <SeveritySummary findings={audit.findings} />
            </div>
          </div>
          <FindingsList findings={audit.findings} empty="All checked security headers look good." />
          {audit.passed.length > 0 && (
            <div className="sec-passed">
              {audit.passed.map((p) => (
                <span key={p} className="sec-passed-item">
                  ✓ {p}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
