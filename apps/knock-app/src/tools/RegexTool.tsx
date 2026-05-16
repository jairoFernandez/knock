import { useMemo } from "react";
import { CopyButton, HistoryList, escapeHtml, useHistory, usePersistedField } from "./shared";

const FLAG_KEYS = ["g", "i", "m", "s", "u", "y"] as const;

export function RegexTool() {
  const [pattern, setPattern] = usePersistedField<string>("knock.tools.regex.pattern", "");
  const [flagsStr, setFlagsStr] = usePersistedField<string>("knock.tools.regex.flags", "g");
  const [text, setText] = usePersistedField<string>("knock.tools.regex.text", "");
  const [replacement, setReplacement] = usePersistedField<string>(
    "knock.tools.regex.replacement",
    "",
  );
  const history = useHistory("knock.tools.regex.history");

  const { error, highlighted, matches, replaced } = useMemo(() => {
    if (!pattern)
      return { error: "", highlighted: escapeHtml(text), matches: [] as RegExpExecArray[], replaced: "" };
    try {
      const re = new RegExp(pattern, flagsStr);
      const ms: RegExpExecArray[] = [];
      if (re.global) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          ms.push(m);
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      } else {
        const m = re.exec(text);
        if (m) ms.push(m);
      }
      // Build highlighted
      let html = "";
      let last = 0;
      for (const m of ms) {
        html += escapeHtml(text.slice(last, m.index));
        html += `<mark class="re-match">${escapeHtml(m[0])}</mark>`;
        last = m.index + m[0].length;
      }
      html += escapeHtml(text.slice(last));
      const replacedStr = replacement ? text.replace(new RegExp(pattern, flagsStr), replacement) : "";
      return { error: "", highlighted: html, matches: ms, replaced: replacedStr };
    } catch (e) {
      return { error: String(e), highlighted: escapeHtml(text), matches: [], replaced: "" };
    }
  }, [pattern, flagsStr, text, replacement]);

  function toggleFlag(f: string) {
    if (flagsStr.includes(f)) setFlagsStr(flagsStr.replace(f, ""));
    else setFlagsStr(flagsStr + f);
  }

  return (
    <>
      <label className="tools-label">Pattern</label>
      <input
        type="text"
        className="tools-input"
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        onBlur={() => history.push("regex", pattern)}
        placeholder="\\b\\w+@\\w+\\.\\w+\\b"
        spellCheck={false}
      />
      <div className="tools-tabs">
        {FLAG_KEYS.map((f) => (
          <button
            key={f}
            className={flagsStr.includes(f) ? "active" : ""}
            onClick={() => toggleFlag(f)}
            title={f}
          >
            {f}
          </button>
        ))}
      </div>
      {error && <div className="tools-error">{error}</div>}
      <label className="tools-label">Test string</label>
      <textarea
        className="tools-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>Matches ({matches.length})</span>
      </div>
      <pre
        className="tools-pre"
        dangerouslySetInnerHTML={{ __html: highlighted || "" }}
      />
      {matches.length > 0 && (
        <ul className="tools-match-list">
          {matches.map((m, i) => (
            <li key={i}>
              <strong>#{i + 1}</strong> @ {m.index}: <code>{m[0]}</code>
              {m.length > 1 && (
                <span className="tools-match-groups">
                  groups: {m.slice(1).map((g, gi) => (
                    <code key={gi}>{g}</code>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="tools-label">Replacement</label>
      <input
        type="text"
        className="tools-input"
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        placeholder="$1"
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>Replaced</span>
        <CopyButton text={replaced} />
      </div>
      <pre className="tools-pre">{replaced}</pre>
      <HistoryList history={history} onPick={setPattern} />
    </>
  );
}
