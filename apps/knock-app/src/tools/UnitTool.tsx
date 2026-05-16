import { useMemo } from "react";
import { CopyInline, useHistory, usePersistedField, HistoryList } from "./shared";

type Category = "bytes" | "time";

const BYTES: { label: string; bytes: number }[] = [
  { label: "B", bytes: 1 },
  { label: "KB", bytes: 1e3 },
  { label: "MB", bytes: 1e6 },
  { label: "GB", bytes: 1e9 },
  { label: "TB", bytes: 1e12 },
  { label: "KiB", bytes: 1024 },
  { label: "MiB", bytes: 1024 ** 2 },
  { label: "GiB", bytes: 1024 ** 3 },
  { label: "TiB", bytes: 1024 ** 4 },
];

const TIME: { label: string; ms: number }[] = [
  { label: "ns", ms: 1e-6 },
  { label: "μs", ms: 1e-3 },
  { label: "ms", ms: 1 },
  { label: "s", ms: 1000 },
  { label: "min", ms: 60_000 },
  { label: "h", ms: 3_600_000 },
  { label: "d", ms: 86_400_000 },
  { label: "wk", ms: 604_800_000 },
];

export function UnitTool() {
  const [cat, setCat] = usePersistedField<Category>("knock.tools.unit.cat", "bytes");
  const [value, setValue] = usePersistedField<string>("knock.tools.unit.value", "1");
  const [unit, setUnit] = usePersistedField<string>("knock.tools.unit.unit", "MB");
  const history = useHistory("knock.tools.unit.history");

  const conversions = useMemo(() => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (cat === "bytes") {
      const base = BYTES.find((b) => b.label === unit) ?? BYTES[0];
      const bytes = n * base.bytes;
      return BYTES.map((b) => ({ label: b.label, value: bytes / b.bytes }));
    }
    const base = TIME.find((t) => t.label === unit) ?? TIME[0];
    const ms = n * base.ms;
    return TIME.map((t) => ({ label: t.label, value: ms / t.ms }));
  }, [cat, value, unit]);

  const units = cat === "bytes" ? BYTES : TIME;

  return (
    <>
      <div className="tools-tabs">
        {(["bytes", "time"] as Category[]).map((c) => (
          <button
            key={c}
            className={cat === c ? "active" : ""}
            onClick={() => {
              setCat(c);
              setUnit(c === "bytes" ? "MB" : "s");
            }}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="tools-row">
        <input
          type="text"
          className="tools-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => history.push(cat, `${value} ${unit}`)}
          spellCheck={false}
          style={{ flex: 1 }}
        />
        <select
          className="tools-input"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        >
          {units.map((u) => (
            <option key={u.label} value={u.label}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
      {conversions && (
        <div className="tools-date-grid">
          {conversions.flatMap((c) => [
            <span key={`l-${c.label}`}>{c.label}</span>,
            <span key={`v-${c.label}`} className="tools-mono">
              {formatNum(c.value)}
              <CopyInline text={formatNum(c.value)} />
            </span>,
          ])}
        </div>
      )}
      <HistoryList history={history} onPick={(v) => setValue(v.split(" ")[0] ?? "")} />
    </>
  );
}

function formatNum(n: number): string {
  if (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e15) return n.toExponential(4);
  if (Number.isInteger(n)) return String(n);
  return n.toPrecision(6).replace(/\.?0+$/, "");
}
