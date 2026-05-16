import { useMemo } from "react";
import { CopyInline, useHistory, usePersistedField, HistoryList } from "./shared";

type Base = 2 | 8 | 10 | 16;
const BASES: { base: Base; label: string }[] = [
  { base: 10, label: "Decimal" },
  { base: 2, label: "Binary" },
  { base: 8, label: "Octal" },
  { base: 16, label: "Hex" },
];

export function NumberBaseTool() {
  const [input, setInput] = usePersistedField<string>("knock.tools.numbase.input", "");
  const [fromBase, setFromBase] = usePersistedField<Base>("knock.tools.numbase.from", 10);
  const history = useHistory("knock.tools.numbase.history");

  const parsed = useMemo(() => {
    const t = input.trim().replace(/^0[xb]/i, "");
    if (!t) return null;
    try {
      const big = BigInt(fromBase === 10 ? t : `${prefix(fromBase)}${t}`);
      return big;
    } catch {
      return null;
    }
  }, [input, fromBase]);

  return (
    <>
      <label className="tools-label">Input ({BASES.find((b) => b.base === fromBase)?.label})</label>
      <div className="tools-tabs">
        {BASES.map((b) => (
          <button
            key={b.base}
            className={fromBase === b.base ? "active" : ""}
            onClick={() => setFromBase(b.base)}
          >
            {b.base}
          </button>
        ))}
      </div>
      <input
        type="text"
        className="tools-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => history.push(String(fromBase), input)}
        spellCheck={false}
      />
      {input && parsed === null && <div className="tools-error">Invalid number for base {fromBase}</div>}
      {parsed !== null && (
        <div className="tools-date-grid">
          {BASES.flatMap((b) => {
            const out = parsed.toString(b.base);
            return [
              <span key={`l-${b.base}`}>{b.label}</span>,
              <span key={`v-${b.base}`} className="tools-mono">
                {out}
                <CopyInline text={out} />
              </span>,
            ];
          })}
        </div>
      )}
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

function prefix(base: Base): string {
  if (base === 16) return "0x";
  if (base === 2) return "0b";
  if (base === 8) return "0o";
  return "";
}
