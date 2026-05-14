import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Kind = "request" | "fragment" | "flow" | "environment";

interface Props {
  root: string;
  initialKind?: Kind;
  onCreated: (rel: string) => void;
  onCancel: () => void;
}

const KINDS: { value: Kind; label: string; placeholder: string; hint: string }[] = [
  { value: "request", label: "Request", placeholder: "users/list", hint: "saved as requests/<path>.toml" },
  { value: "fragment", label: "Fragment", placeholder: "auth/bearer", hint: "saved as fragments/<path>.toml" },
  { value: "flow", label: "Flow", placeholder: "checkout", hint: "saved as flows/<path>.toml" },
  { value: "environment", label: "Environment", placeholder: "staging", hint: "saved as environments/<path>.toml" },
];

export function NewEntryModal({ root, initialKind = "request", onCreated, onCancel }: Props) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const config = KINDS.find((k) => k.value === kind)!;

  async function create() {
    setError(null);
    if (!path.trim()) return setError("Enter a path.");
    setBusy(true);
    try {
      const rel = await invoke<string>("create_entry", {
        root,
        kind,
        rel: path.trim(),
      });
      onCreated(rel);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New entry</h2>

        <div className="kind-row">
          {KINDS.map((k) => (
            <button
              key={k.value}
              className={`kind-pill ${kind === k.value ? "active" : ""}`}
              onClick={() => setKind(k.value)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <label>
          Path
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={config.placeholder}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
          <span className="modal-hint">{config.hint}</span>
        </label>

        {error && <div className="error">{error}</div>}

        <div className="row right">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
