import { useMemo } from "react";
import { CopyInline, HistoryList, useHistory, usePersistedField, relTime } from "./shared";

export function CronTool() {
  const [expr, setExpr] = usePersistedField<string>("knock.tools.cron.expr", "*/5 * * * *");
  const history = useHistory("knock.tools.cron.history");

  const { fields, nextFires, error, description } = useMemo(() => {
    try {
      const parts = expr.trim().split(/\s+/);
      if (parts.length !== 5) throw new Error("Expected 5 fields: minute hour dom month dow");
      const fields = {
        minute: parts[0],
        hour: parts[1],
        dom: parts[2],
        month: parts[3],
        dow: parts[4],
      };
      const fires = computeNextFires(parts, 5);
      const description = describe(parts);
      return { fields, nextFires: fires, error: "", description };
    } catch (e) {
      return { fields: null, nextFires: [], error: String(e), description: "" };
    }
  }, [expr]);

  return (
    <>
      <label className="tools-label">Cron expression (minute hour dom month dow)</label>
      <input
        type="text"
        className="tools-input"
        value={expr}
        onChange={(e) => setExpr(e.target.value)}
        onBlur={() => history.push("cron", expr)}
        placeholder="*/5 * * * *"
        spellCheck={false}
      />
      {error && <div className="tools-error">{error}</div>}
      {fields && (
        <>
          <div className="tools-date-grid">
            <span>Description</span>
            <span className="tools-mono">{description}</span>
            <span>Minute</span>
            <span className="tools-mono">{fields.minute}</span>
            <span>Hour</span>
            <span className="tools-mono">{fields.hour}</span>
            <span>Day of month</span>
            <span className="tools-mono">{fields.dom}</span>
            <span>Month</span>
            <span className="tools-mono">{fields.month}</span>
            <span>Day of week</span>
            <span className="tools-mono">{fields.dow}</span>
          </div>
          <div className="tools-output-header">
            <span>Next fires</span>
          </div>
          <ul className="tools-fires">
            {nextFires.map((d, i) => (
              <li key={i}>
                <span className="tools-mono">{d.toLocaleString()}</span>
                <span className="tools-date-rel">{relTime(d.getTime())}</span>
                <CopyInline text={d.toISOString()} />
              </li>
            ))}
          </ul>
        </>
      )}
      <HistoryList history={history} onPick={setExpr} />
    </>
  );
}

function describe(parts: string[]): string {
  const [m, h] = parts;
  if (parts.every((p) => p === "*")) return "Every minute";
  if (m === "0" && h === "*") return "Every hour at minute 0";
  if (m.startsWith("*/")) return `Every ${m.slice(2)} minute(s)`;
  if (m === "0" && /^\d+$/.test(h)) return `Daily at ${h.padStart(2, "0")}:00`;
  return parts.join(" ");
}

function parseField(field: string, min: number, max: number): number[] {
  const set = new Set<number>();
  for (const piece of field.split(",")) {
    let step = 1;
    let range = piece;
    if (piece.includes("/")) {
      const [r, s] = piece.split("/");
      step = Number(s);
      range = r;
    }
    let lo: number, hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = Number(range);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`Bad field: ${field}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return Array.from(set).sort((a, b) => a - b);
}

function computeNextFires(parts: string[], count: number): Date[] {
  const minutes = new Set(parseField(parts[0], 0, 59));
  const hours = new Set(parseField(parts[1], 0, 23));
  const doms = new Set(parseField(parts[2], 1, 31));
  const months = new Set(parseField(parts[3], 1, 12));
  const dows = new Set(parseField(parts[4], 0, 6));
  const fires: Date[] = [];
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  let limit = 0;
  while (fires.length < count && limit < 525600) {
    if (
      minutes.has(d.getMinutes()) &&
      hours.has(d.getHours()) &&
      doms.has(d.getDate()) &&
      months.has(d.getMonth() + 1) &&
      dows.has(d.getDay())
    ) {
      fires.push(new Date(d));
    }
    d.setMinutes(d.getMinutes() + 1);
    limit++;
  }
  return fires;
}
