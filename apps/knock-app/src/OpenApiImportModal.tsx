import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  OpenApiOperationPreview,
  OpenApiPreview,
  OpenApiSource,
  TreeEntry,
} from "./types";

interface Props {
  root: string;
  onDone: (tree: TreeEntry[]) => void;
  onCancel: () => void;
}

type Tab = "url" | "file";

export function OpenApiImportModal({ root, onDone, onCancel }: Props) {
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState<string>("");
  const [filePath, setFilePath] = useState<string>("");
  const [bytesB64, setBytesB64] = useState<string>("");
  const [preview, setPreview] = useState<OpenApiPreview | null>(null);
  const [sourceUsed, setSourceUsed] = useState<OpenApiSource | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasManualWarning = useMemo(
    () =>
      preview?.operations.some(
        (op) => selected[op.operationId] && op.existingWasManuallyEdited,
      ) ?? false,
    [preview, selected],
  );

  async function pickFile() {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "OpenAPI", extensions: ["json", "yaml", "yml"] },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (picked && typeof picked === "string") setFilePath(picked);
  }

  async function doPreview() {
    setError(null);
    setBusy(true);
    setPreview(null);
    try {
      const source: OpenApiSource =
        tab === "url"
          ? { kind: "url", value: url.trim() }
          : { kind: "file", value: filePath };
      if (!source.value) {
        throw new Error(tab === "url" ? "Enter a URL" : "Pick a file");
      }
      const bytes = await invoke<number[]>("openapi_fetch", { source });
      const b64 = bytesToBase64(bytes);
      setBytesB64(b64);
      setSourceUsed(source);
      const pv = await invoke<OpenApiPreview>("openapi_preview_import", {
        root,
        bytes,
        sourceUrl: source.kind === "url" ? source.value : null,
      });
      setPreview(pv);
      const initSel: Record<string, boolean> = {};
      for (const op of pv.operations) {
        initSel[op.operationId] = op.status !== "unchanged";
      }
      setSelected(initSel);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyImport() {
    if (!preview || !sourceUsed) return;
    setError(null);
    setBusy(true);
    try {
      const selections = preview.operations
        .filter((op) => selected[op.operationId])
        .map((op) => ({
          operationId: op.operationId,
          action: op.status === "removed" ? "delete" : op.status === "new" ? "create" : "overwrite",
        }));
      const bytes = base64ToBytes(bytesB64);
      const tree = await invoke<TreeEntry[]>("openapi_apply_import", {
        root,
        bytes,
        source: sourceUsed,
        selections,
      });
      onDone(tree);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleAll(value: boolean) {
    if (!preview) return;
    const next: Record<string, boolean> = {};
    for (const op of preview.operations) next[op.operationId] = value;
    setSelected(next);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal openapi-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(900px, 92vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      >
        <h2>Import OpenAPI</h2>
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <button
            className={tab === "url" ? "primary" : ""}
            onClick={() => setTab("url")}
          >
            From URL
          </button>
          <button
            className={tab === "file" ? "primary" : ""}
            onClick={() => setTab("file")}
          >
            From file
          </button>
        </div>

        {tab === "url" ? (
          <label>
            Spec URL
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
            />
          </label>
        ) : (
          <label>
            Spec file
            <div className="row">
              <input
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="/path/to/openapi.json"
              />
              <button onClick={pickFile}>Browse…</button>
            </div>
          </label>
        )}

        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button onClick={doPreview} disabled={busy}>
            {busy && !preview ? "Loading…" : "Preview"}
          </button>
        </div>

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

        {preview && (
          <div style={{ marginTop: 12, overflow: "auto", flex: 1 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <div>
                <strong>{preview.title ?? "Untitled"}</strong>
                <span style={{ marginLeft: 8, opacity: 0.7 }}>
                  {preview.specFormat} · v{preview.specVersion} · {preview.operations.length} ops
                </span>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button onClick={() => toggleAll(true)}>All</button>
                <button onClick={() => toggleAll(false)}>None</button>
              </div>
            </div>

            {hasManualWarning && (
              <div
                className="error"
                style={{ background: "#5a4413", color: "#fde68a", marginTop: 8 }}
              >
                Some selected requests were edited locally. Importing will overwrite them.
              </div>
            )}

            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.7 }}>
                  <th></th>
                  <th>Status</th>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Operation</th>
                  <th>Tag</th>
                </tr>
              </thead>
              <tbody>
                {preview.operations.map((op) => (
                  <OperationRow
                    key={op.operationId}
                    op={op}
                    checked={!!selected[op.operationId]}
                    onToggle={(v) =>
                      setSelected((s) => ({ ...s, [op.operationId]: v }))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row right" style={{ marginTop: 12 }}>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={applyImport}
            disabled={busy || !preview}
          >
            {busy && preview ? "Importing…" : "Import selected"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OperationRow({
  op,
  checked,
  onToggle,
}: {
  op: OpenApiOperationPreview;
  checked: boolean;
  onToggle: (v: boolean) => void;
}) {
  const statusColor: Record<string, string> = {
    new: "#16a34a",
    modified: "#d97706",
    unchanged: "#737373",
    removed: "#dc2626",
  };
  return (
    <tr style={{ borderTop: "1px solid #2a2a2a" }}>
      <td>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={op.status === "unchanged"}
        />
      </td>
      <td>
        <span
          style={{
            color: statusColor[op.status],
            fontWeight: 600,
            fontSize: 11,
            textTransform: "uppercase",
          }}
        >
          {op.status}
        </span>
        {op.existingWasManuallyEdited && (
          <span
            title="Edited locally"
            style={{ marginLeft: 4, color: "#fde68a" }}
          >
            ⚠
          </span>
        )}
      </td>
      <td>
        <code>{op.method}</code>
      </td>
      <td>
        <code>{op.path}</code>
      </td>
      <td>{op.operationId}</td>
      <td style={{ opacity: 0.7 }}>{op.tag ?? ""}</td>
    </tr>
  );
}

function bytesToBase64(bytes: number[]): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): number[] {
  const bin = atob(b64);
  const out: number[] = [];
  for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
  return out;
}
