import { useMemo } from "react";
import { CopyButton, HistoryList, useHistory, usePersistedField } from "./shared";

type Mode = "format" | "minify";

export function GraphqlTool() {
  const [mode, setMode] = usePersistedField<Mode>("knock.tools.gql.mode", "format");
  const [input, setInput] = usePersistedField<string>("knock.tools.gql.input", "");
  const history = useHistory("knock.tools.gql.history");

  const output = useMemo(() => {
    if (!input.trim()) return "";
    try {
      return mode === "format" ? formatGql(input) : minifyGql(input);
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }, [input, mode]);

  return (
    <>
      <div className="tools-tabs">
        {(["format", "minify"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea tools-textarea-tall"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => history.push(mode, input)}
        placeholder="query Hello { user(id: 1) { name email } }"
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      <textarea
        className="tools-textarea tools-output tools-textarea-tall"
        value={output}
        readOnly
        spellCheck={false}
      />
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

function minifyGql(src: string): string {
  return src
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}()\[\]:,])\s*/g, "$1")
    .trim();
}

function formatGql(src: string): string {
  // Tokenize: braces, parens, commas, names, strings
  const stripped = src.replace(/#[^\n]*/g, "");
  let depth = 0;
  let out = "";
  let i = 0;
  let lineStart = true;
  while (i < stripped.length) {
    const c = stripped[i];
    if (c === "{") {
      out = out.trimEnd() + " {\n" + "  ".repeat(++depth);
      lineStart = true;
      i++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      out = out.trimEnd() + "\n" + "  ".repeat(depth) + "}";
      i++;
      // newline after closing
      if (i < stripped.length && stripped[i] !== ")") {
        out += "\n" + "  ".repeat(depth);
        lineStart = true;
      }
    } else if (c === "\n") {
      i++;
    } else if (/\s/.test(c)) {
      if (!lineStart && !/\s$/.test(out)) out += " ";
      i++;
    } else {
      out += c;
      lineStart = false;
      i++;
    }
  }
  return out.replace(/\n\s*\n/g, "\n").trim();
}
