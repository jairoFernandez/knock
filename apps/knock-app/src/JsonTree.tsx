import { useState } from "react";

interface Props {
  value: unknown;
  rootLabel?: string;
  initialExpandDepth?: number;
}

export function JsonTree({ value, rootLabel, initialExpandDepth = 2 }: Props) {
  return (
    <div className="json-tree">
      <Node value={value} label={rootLabel} depth={0} initialExpandDepth={initialExpandDepth} isLast />
    </div>
  );
}

interface NodeProps {
  value: unknown;
  label?: string | number;
  depth: number;
  initialExpandDepth: number;
  isLast: boolean;
}

function Node({ value, label, depth, initialExpandDepth, isLast }: NodeProps) {
  const isObj = value !== null && typeof value === "object";
  const isArr = Array.isArray(value);
  const [open, setOpen] = useState(depth < initialExpandDepth);

  if (!isObj) {
    return (
      <div className="json-row">
        <span className="json-indent" style={{ width: depth * 14 }} />
        {label !== undefined && <span className="json-key">{formatKey(label)}: </span>}
        <Primitive value={value} />
        {!isLast && <span className="json-comma">,</span>}
      </div>
    );
  }

  const entries: [string | number, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const openBr = isArr ? "[" : "{";
  const closeBr = isArr ? "]" : "}";
  const count = entries.length;

  if (count === 0) {
    return (
      <div className="json-row">
        <span className="json-indent" style={{ width: depth * 14 }} />
        {label !== undefined && <span className="json-key">{formatKey(label)}: </span>}
        <span className="json-bracket">{openBr}{closeBr}</span>
        {!isLast && <span className="json-comma">,</span>}
      </div>
    );
  }

  return (
    <div className="json-block">
      <div className="json-row json-clickable" onClick={() => setOpen(!open)}>
        <span className="json-indent" style={{ width: depth * 14 }} />
        <span className="json-toggle">{open ? "▾" : "▸"}</span>
        {label !== undefined && <span className="json-key">{formatKey(label)}: </span>}
        <span className="json-bracket">{openBr}</span>
        {!open && (
          <>
            <span className="json-preview"> {summary(entries, isArr)} </span>
            <span className="json-bracket">{closeBr}</span>
            {!isLast && <span className="json-comma">,</span>}
          </>
        )}
        {open && <span className="json-count"> // {count}</span>}
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <Node
              key={String(k)}
              value={v}
              label={k}
              depth={depth + 1}
              initialExpandDepth={initialExpandDepth}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className="json-row">
            <span className="json-indent" style={{ width: depth * 14 }} />
            <span className="json-bracket">{closeBr}</span>
            {!isLast && <span className="json-comma">,</span>}
          </div>
        </>
      )}
    </div>
  );
}

function formatKey(k: string | number): string {
  if (typeof k === "number") return String(k);
  return `"${k}"`;
}

function summary(entries: [string | number, unknown][], isArr: boolean): string {
  const n = entries.length;
  if (isArr) return `${n} item${n === 1 ? "" : "s"}`;
  const keys = entries.slice(0, 3).map(([k]) => k).join(", ");
  return n > 3 ? `${keys}, +${n - 3}` : keys;
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "string") return <span className="json-str">"{escapeStr(value)}"</span>;
  if (typeof value === "number") return <span className="json-num">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json-bool">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
