import { useEffect, useId, useState } from "react";
import type { KV } from "./types";
import { TemplatedInput } from "./TemplatedInput";
import { hintFor, valuesFor, type KeyHint } from "./headerHints";

interface Props {
  rows: KV[];
  vars: Record<string, string>;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  hints?: KeyHint[];
  onChange: (next: KV[]) => void;
}

export function KVTable({ rows, vars, keyPlaceholder, valuePlaceholder, hints, onChange }: Props) {
  const listId = useId();
  const [menuFor, setMenuFor] = useState<number | null>(null);

  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuFor]);

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

  function addHint(h: KeyHint) {
    const idx = rows.findIndex((r) => r.key.trim().toLowerCase() === h.key.toLowerCase());
    if (idx !== -1) update(idx, { value: h.value });
    else onChange([...rows.filter((r) => r.key.trim() || r.value.trim()), { key: h.key, value: h.value }]);
  }

  const uniqueKeys = hints ? Array.from(new Set(hints.map((h) => h.key))) : [];

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
      {rows.map((row, idx) => {
        const values = hints ? valuesFor(hints, row.key) : [];
        const valueListId = `${listId}-v${idx}`;
        return (
        <div className="kv-row" key={idx}>
          <input
            className="kv-key"
            value={row.key}
            placeholder={keyPlaceholder ?? "name"}
            onChange={(e) => update(idx, { key: e.target.value })}
            list={hints ? listId : undefined}
            spellCheck={false}
          />
          <div className="kv-value">
          <TemplatedInput
            value={row.value}
            onChange={(v) => update(idx, { value: v })}
            vars={vars}
            placeholder={(hints && hintFor(hints, row.key)?.value) ?? valuePlaceholder ?? "value"}
            list={values.length > 0 ? valueListId : undefined}
            monospace
          />
          {values.length > 0 && (
            <>
              <datalist id={valueListId}>
                {values.map((h) => (
                  <option key={h.value} value={h.value} label={h.description} />
                ))}
              </datalist>
              <button
                className="kv-value-toggle"
                title="Suggested values"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setMenuFor(menuFor === idx ? null : idx)}
              >
                ▾
              </button>
              {menuFor === idx && (
                <div className="kv-value-menu" onMouseDown={(e) => e.stopPropagation()}>
                  {values.map((h) => (
                    <button
                      key={h.value}
                      className={`kv-value-option${h.value === row.value ? " active" : ""}`}
                      onClick={() => {
                        update(idx, { value: h.value });
                        setMenuFor(null);
                      }}
                    >
                      <span className="kv-value-option-value">{h.value}</span>
                      <span className="kv-value-option-desc">{h.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          </div>
          <button className="kv-remove" onClick={() => remove(idx)} title="Remove">
            ×
          </button>
        </div>
        );
      })}
      {hints && (
        <datalist id={listId}>
          {uniqueKeys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      )}
      <div className="kv-actions">
        <button className="kv-add" onClick={add}>
          + Add row
        </button>
        {hints && (
          <select
            className="kv-presets"
            value=""
            onChange={(e) => {
              const h = hints[Number(e.target.value)];
              if (h) addHint(h);
            }}
          >
            <option value="">+ Common…</option>
            {hints.map((h, i) => (
              <option key={i} value={i}>
                {h.key}: {h.value} — {h.description}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
