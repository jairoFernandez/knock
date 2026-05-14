import type { KV } from "./types";
import { TemplatedInput } from "./TemplatedInput";

interface Props {
  rows: KV[];
  vars: Record<string, string>;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  onChange: (next: KV[]) => void;
}

export function KVTable({ rows, vars, keyPlaceholder, valuePlaceholder, onChange }: Props) {
  function update(idx: number, patch: Partial<KV>) {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange(next);
  }

  function remove(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([...rows, { key: "", value: "" }]);
  }

  return (
    <div className="kv-table">
      <div className="kv-header">
        <div>Name</div>
        <div>Value</div>
        <div></div>
      </div>
      {rows.length === 0 && (
        <div className="kv-empty">No entries yet.</div>
      )}
      {rows.map((row, idx) => (
        <div className="kv-row" key={idx}>
          <input
            className="kv-key"
            value={row.key}
            placeholder={keyPlaceholder ?? "name"}
            onChange={(e) => update(idx, { key: e.target.value })}
            spellCheck={false}
          />
          <TemplatedInput
            value={row.value}
            onChange={(v) => update(idx, { value: v })}
            vars={vars}
            placeholder={valuePlaceholder ?? "value"}
            monospace
          />
          <button className="kv-remove" onClick={() => remove(idx)} title="Remove">
            ×
          </button>
        </div>
      ))}
      <button className="kv-add" onClick={add}>
        + Add row
      </button>
    </div>
  );
}
