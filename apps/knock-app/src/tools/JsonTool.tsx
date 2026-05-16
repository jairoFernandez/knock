import { useMemo } from "react";
import { CopyButton, HighlightedJsonEditor, HistoryList, useHistory, usePersistedField } from "./shared";

type Mode = "format" | "minify" | "yaml" | "query";

export function JsonTool() {
  const [mode, setMode] = usePersistedField<Mode>("knock.tools.json.mode", "format");
  const [input, setInput] = usePersistedField<string>("knock.tools.json.input", "");
  const [indent, setIndent] = usePersistedField<number>("knock.tools.json.indent", 2);
  const [query, setQuery] = usePersistedField<string>("knock.tools.json.query", "$");
  const history = useHistory("knock.tools.json.history");

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: "", error: "" };
    try {
      const obj = JSON.parse(input);
      if (mode === "format") return { output: JSON.stringify(obj, null, indent), error: "" };
      if (mode === "minify") return { output: JSON.stringify(obj), error: "" };
      if (mode === "yaml") return { output: toYaml(obj, 0), error: "" };
      if (mode === "query") {
        const result = jsonPath(obj, query);
        return { output: JSON.stringify(result, null, indent), error: "" };
      }
      return { output: "", error: "" };
    } catch (e) {
      return { output: "", error: String(e) };
    }
  }, [input, mode, indent, query]);

  return (
    <>
      <div className="tools-tabs tools-tabs-wrap">
        {(["format", "minify", "yaml", "query"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      {mode === "format" && (
        <div className="tools-row">
          <label className="tools-label" style={{ flex: 1 }}>
            Indent
          </label>
          <input
            type="number"
            className="tools-input"
            min={0}
            max={8}
            value={indent}
            onChange={(e) => setIndent(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
          />
        </div>
      )}
      {mode === "query" && (
        <>
          <label className="tools-label">JSONPath (e.g. $.users[0].name, $..id)</label>
          <input
            type="text"
            className="tools-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </>
      )}
      <label className="tools-label">Input</label>
      <HighlightedJsonEditor
        value={input}
        onChange={(v) => {
          setInput(v);
          history.push(mode, v);
        }}
      />
      {error && <div className="tools-error">{error}</div>}
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      {mode === "yaml" ? (
        <pre className="tools-pre">{output}</pre>
      ) : (
        <HighlightedJsonEditor value={output} onChange={() => {}} />
      )}
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

function toYaml(value: unknown, depth: number): string {
  const indent = "  ".repeat(depth);
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((v) => {
        if (v !== null && typeof v === "object") {
          const inner = toYaml(v, depth + 1);
          return `${indent}-\n${inner}`;
        }
        return `${indent}- ${toYaml(v, depth + 1).replace(/^\s+/, "")}`;
      })
      .join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return entries
    .map(([k, v]) => {
      if (v !== null && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
        return `${indent}${k}:\n${toYaml(v, depth + 1)}`;
      }
      return `${indent}${k}: ${toYaml(v, depth + 1)}`;
    })
    .join("\n");
}

function jsonPath(obj: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "$") return obj;
  // Recursive descent: $..key
  if (trimmed.startsWith("$..")) {
    const key = trimmed.slice(3);
    const found: unknown[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === "object") {
        if (Array.isArray(v)) v.forEach(walk);
        else {
          for (const [k, val] of Object.entries(v)) {
            if (k === key) found.push(val);
            walk(val);
          }
        }
      }
    };
    walk(obj);
    return found;
  }
  // Simple: $.a.b[0].c
  const tokens = trimmed.replace(/^\$\.?/, "").match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    const idxMatch = t.match(/^\[(\d+)\]$/);
    if (idxMatch && Array.isArray(cur)) cur = cur[Number(idxMatch[1])];
    else cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}
