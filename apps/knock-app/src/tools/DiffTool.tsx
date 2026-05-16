import { useMemo } from "react";
import { escapeHtml, usePersistedField } from "./shared";

export function DiffTool() {
  const [left, setLeft] = usePersistedField<string>("knock.tools.diff.left", "");
  const [right, setRight] = usePersistedField<string>("knock.tools.diff.right", "");
  const [tryJson, setTryJson] = usePersistedField<boolean>("knock.tools.diff.json", true);

  const { leftPretty, rightPretty } = useMemo(() => {
    if (!tryJson) return { leftPretty: left, rightPretty: right };
    const fmt = (s: string) => {
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        return s;
      }
    };
    return { leftPretty: fmt(left), rightPretty: fmt(right) };
  }, [left, right, tryJson]);

  const lines = useMemo(() => diffLines(leftPretty.split("\n"), rightPretty.split("\n")), [
    leftPretty,
    rightPretty,
  ]);

  return (
    <>
      <div className="tools-output-header">
        <span>Compare</span>
        <label className="tools-checkbox">
          <input type="checkbox" checked={tryJson} onChange={(e) => setTryJson(e.target.checked)} />
          format JSON
        </label>
      </div>
      <div className="tools-diff-inputs">
        <textarea
          className="tools-textarea"
          value={left}
          onChange={(e) => setLeft(e.target.value)}
          placeholder="Left"
          spellCheck={false}
        />
        <textarea
          className="tools-textarea"
          value={right}
          onChange={(e) => setRight(e.target.value)}
          placeholder="Right"
          spellCheck={false}
        />
      </div>
      <div className="tools-output-header">
        <span>Diff</span>
      </div>
      <div className="tools-diff-view">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line diff-${l.kind}`}>
            <span className="diff-marker">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
            <span
              className="diff-text"
              dangerouslySetInnerHTML={{ __html: escapeHtml(l.text) || "&nbsp;" }}
            />
          </div>
        ))}
      </div>
    </>
  );
}

interface Line {
  kind: "same" | "add" | "del";
  text: string;
}

// Myers-style diff (simple LCS-based)
function diffLines(a: string[], b: string[]): Line[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Line[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < m) out.push({ kind: "del", text: a[i++] });
  while (j < n) out.push({ kind: "add", text: b[j++] });
  return out;
}
