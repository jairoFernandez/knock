import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  root: string;
  current: { color?: string | null; icon?: string | null };
  onSaved: (next: { color: string | null; icon: string | null }) => void;
  onCancel: () => void;
}

const PALETTE = [
  "#8b6cff", "#6ec9d6", "#75d76b", "#e0a04a",
  "#e36572", "#d96cd6", "#5b8ef0", "#9b9ea8",
];

const ICONS = ["★", "◆", "●", "▲", "■", "♠", "♣", "♥", "♦", "✦", "✧", "⚡", "⚙", "⌂", "☕", "🔥", "🚀", "🐍", "🦀", "🍃"];

export function WorkspaceAppearanceModal({ root, current, onSaved, onCancel }: Props) {
  const [color, setColor] = useState<string>(current.color ?? "");
  const [icon, setIcon] = useState<string>(current.icon ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await invoke("set_workspace_appearance", {
        root,
        color: color.trim() || null,
        icon: icon.trim() || null,
      });
      onSaved({ color: color.trim() || null, icon: icon.trim() || null });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Workspace appearance</h2>

        <label>
          Color
          <div className="ws-palette">
            <button
              type="button"
              className={`ws-color-chip none ${color === "" ? "active" : ""}`}
              onClick={() => setColor("")}
              title="No color"
            >
              ×
            </button>
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={`ws-color-chip ${color === c ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
            <input
              type="text"
              className="ws-color-input"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="#rrggbb"
            />
          </div>
        </label>

        <label>
          Icon
          <div className="ws-icon-grid">
            <button
              type="button"
              className={`ws-icon-chip none ${icon === "" ? "active" : ""}`}
              onClick={() => setIcon("")}
              title="No icon"
            >
              ×
            </button>
            {ICONS.map((i) => (
              <button
                key={i}
                type="button"
                className={`ws-icon-chip ${icon === i ? "active" : ""}`}
                onClick={() => setIcon(i)}
              >
                {i}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={icon}
            onChange={(e) => setIcon(e.target.value.slice(0, 4))}
            placeholder="emoji or char"
            maxLength={4}
          />
        </label>

        <div className="ws-preview">
          <span className="ws-preview-label">Preview</span>
          <span
            className="ws-preview-badge"
            style={color ? { background: color, color: "#fff", borderColor: color } : {}}
          >
            {icon && <span className="ws-preview-icon">{icon}</span>}
            <span>workspace</span>
          </span>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="row right">
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
