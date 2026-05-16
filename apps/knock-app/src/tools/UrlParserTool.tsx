import { useMemo } from "react";
import { CopyInline, HistoryList, useHistory, usePersistedField } from "./shared";

export function UrlParserTool() {
  const [input, setInput] = usePersistedField<string>("knock.tools.urlparse.input", "");
  const history = useHistory("knock.tools.urlparse.history");

  const parsed = useMemo(() => {
    if (!input.trim()) return null;
    try {
      const u = new URL(input);
      const params: { key: string; value: string }[] = [];
      u.searchParams.forEach((v, k) => params.push({ key: k, value: v }));
      return {
        protocol: u.protocol.replace(":", ""),
        username: u.username,
        password: u.password,
        host: u.host,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash.replace("#", ""),
        origin: u.origin,
        params,
      };
    } catch (e) {
      return { error: String(e) };
    }
  }, [input]);

  return (
    <>
      <label className="tools-label">URL</label>
      <textarea
        className="tools-textarea"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => history.push("url", input)}
        placeholder="https://user:pass@example.com:8080/path?a=1&b=2#frag"
        spellCheck={false}
      />
      {parsed && "error" in parsed && <div className="tools-error">{parsed.error}</div>}
      {parsed && !("error" in parsed) && (
        <>
          <div className="tools-date-grid">
            <span>Protocol</span>
            <span className="tools-mono">{parsed.protocol}</span>
            <span>Origin</span>
            <span className="tools-mono">
              {parsed.origin}
              <CopyInline text={parsed.origin} />
            </span>
            {parsed.username && (
              <>
                <span>User</span>
                <span className="tools-mono">{parsed.username}</span>
              </>
            )}
            {parsed.password && (
              <>
                <span>Pass</span>
                <span className="tools-mono">{parsed.password}</span>
              </>
            )}
            <span>Hostname</span>
            <span className="tools-mono">{parsed.hostname}</span>
            {parsed.port && (
              <>
                <span>Port</span>
                <span className="tools-mono">{parsed.port}</span>
              </>
            )}
            <span>Path</span>
            <span className="tools-mono">
              {parsed.pathname}
              <CopyInline text={parsed.pathname} />
            </span>
            {parsed.hash && (
              <>
                <span>Fragment</span>
                <span className="tools-mono">{parsed.hash}</span>
              </>
            )}
          </div>
          {parsed.params.length > 0 && (
            <>
              <div className="tools-output-header">
                <span>Query params</span>
              </div>
              <table className="tools-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.params.map((p, i) => (
                    <tr key={i}>
                      <td className="tools-mono">{p.key}</td>
                      <td className="tools-mono">
                        {p.value}
                        <CopyInline text={p.value} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}
