import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  OpenApiPreview,
  OpenApiSource,
  TreeEntry,
  WorkspaceInfo,
} from "./types";

interface Props {
  onCreated: (info: WorkspaceInfo) => void;
  onCancel: () => void;
}

const PALETTE = [
  "#8b6cff",
  "#6ec9d6",
  "#75d76b",
  "#e0a04a",
  "#e36572",
  "#d96cd6",
  "#5b8ef0",
  "#9b9ea8",
];

const ICONS = [
  "★", "◆", "●", "▲", "■", "♠", "♣", "♥", "♦", "✦",
  "✧", "⚡", "⚙", "⌂", "☕", "🔥", "🚀", "🐍", "🦀", "🍃",
];

export function NewWorkspaceModal({ onCreated, onCancel }: Props) {
  const [parent, setParent] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [git, setGit] = useState<boolean>(true);
  const [color, setColor] = useState<string>("");
  const [icon, setIcon] = useState<string>("");
  const [openapiUrl, setOpenapiUrl] = useState<string>("");
  const [openapiFile, setOpenapiFile] = useState<string>("");
  const [openapiTab, setOpenapiTab] = useState<"none" | "url" | "file">("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function pickParent() {
    const picked = await open({ directory: true, multiple: false });
    if (picked && typeof picked === "string") setParent(picked);
  }

  async function pickFile() {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "OpenAPI", extensions: ["json", "yaml", "yml"] },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (picked && typeof picked === "string") setOpenapiFile(picked);
  }

  async function create() {
    setError(null);
    if (!parent) return setError("Choose a parent directory.");
    if (!name.trim()) return setError("Enter a workspace name.");
    const source: OpenApiSource | null =
      openapiTab === "url" && openapiUrl.trim()
        ? { kind: "url", value: openapiUrl.trim() }
        : openapiTab === "file" && openapiFile
          ? { kind: "file", value: openapiFile }
          : null;

    setBusy(true);
    try {
      setProgress("Creating workspace…");
      let info = await invoke<WorkspaceInfo>("init_workspace", {
        parent,
        name: name.trim(),
        git,
      });

      const finalColor = color.trim() || null;
      const finalIcon = icon.trim() || null;
      if (finalColor || finalIcon) {
        try {
          setProgress("Applying appearance…");
          await invoke("set_workspace_appearance", {
            root: info.root,
            color: finalColor,
            icon: finalIcon,
          });
          info = { ...info, color: finalColor, icon: finalIcon };
        } catch (e) {
          console.error("set_workspace_appearance failed", e);
        }
      }

      if (source) {
        try {
          setProgress("Fetching OpenAPI spec…");
          const bytes = await invoke<number[]>("openapi_fetch", { source });
          setProgress("Parsing operations…");
          const preview = await invoke<OpenApiPreview>(
            "openapi_preview_import",
            {
              root: info.root,
              bytes,
              sourceUrl: source.kind === "url" ? source.value : null,
            },
          );
          const selections = preview.operations.map((op) => ({
            operationId: op.operationId,
            action: "create",
          }));
          setProgress(`Importing ${selections.length} operations…`);
          await invoke<TreeEntry[]>("openapi_apply_import", {
            root: info.root,
            bytes,
            source,
            selections,
          });
        } catch (e) {
          setError(`Workspace created but OpenAPI import failed: ${e}`);
          onCreated(info);
          return;
        }
      }

      onCreated(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New workspace</h2>
        <label>
          Parent directory
          <div className="row">
            <input
              type="text"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              placeholder="/path/to/parent"
            />
            <button onClick={pickParent}>Browse…</button>
          </div>
        </label>
        <label>
          Workspace name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-api"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && openapiTab === "none") create();
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={git}
            onChange={(e) => setGit(e.target.checked)}
          />
          Initialize a git repo
        </label>

        <div style={{ marginTop: 8, borderTop: "1px solid #2a2a2a", paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
            Appearance (optional)
          </div>
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
          {(color || icon) && (
            <div className="ws-preview">
              <span className="ws-preview-label">Preview</span>
              <span
                className="ws-preview-badge"
                style={
                  color
                    ? { background: color, color: "#fff", borderColor: color }
                    : {}
                }
              >
                {icon && <span className="ws-preview-icon">{icon}</span>}
                <span>{name.trim() || "workspace"}</span>
              </span>
            </div>
          )}
        </div>

        <div style={{ marginTop: 8, borderTop: "1px solid #2a2a2a", paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
            Bootstrap from OpenAPI (optional)
          </div>
          <div className="row" style={{ gap: 4, marginBottom: 6 }}>
            <button
              className={openapiTab === "none" ? "primary" : ""}
              onClick={() => setOpenapiTab("none")}
              type="button"
            >
              None
            </button>
            <button
              className={openapiTab === "url" ? "primary" : ""}
              onClick={() => setOpenapiTab("url")}
              type="button"
            >
              From URL
            </button>
            <button
              className={openapiTab === "file" ? "primary" : ""}
              onClick={() => setOpenapiTab("file")}
              type="button"
            >
              From file
            </button>
          </div>
          {openapiTab === "url" && (
            <input
              type="text"
              value={openapiUrl}
              onChange={(e) => setOpenapiUrl(e.target.value)}
              placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
            />
          )}
          {openapiTab === "file" && (
            <div className="row">
              <input
                type="text"
                value={openapiFile}
                onChange={(e) => setOpenapiFile(e.target.value)}
                placeholder="/path/to/openapi.json"
              />
              <button onClick={pickFile} type="button">
                Browse…
              </button>
            </div>
          )}
        </div>

        {progress && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>{progress}</div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row right">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
