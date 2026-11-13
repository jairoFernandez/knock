import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Kind = "request" | "fragment" | "flow" | "environment" | "folder";

interface Props {
  root: string;
  initialKind?: Kind;
  initialPath?: string;
  folders?: string[];
  onCreated: (rel: string, kind: Kind) => void;
  onCancel: () => void;
}

const KINDS: { value: Kind; label: string; placeholder: string; hint: string }[] = [
  { value: "request", label: "Request", placeholder: "users/list", hint: "saved as requests/<path>.toml" },
  { value: "folder", label: "Folder", placeholder: "github.com/repos", hint: "saved under requests/<path>/" },
  { value: "fragment", label: "Fragment", placeholder: "auth/bearer", hint: "saved as fragments/<path>.toml" },
  { value: "flow", label: "Flow", placeholder: "checkout", hint: "saved as flows/<path>.toml" },
  { value: "environment", label: "Environment", placeholder: "staging", hint: "saved as environments/<path>.toml" },
];

interface UrlDerivation {
  host: string;
  name: string;
}

const NOISE_RE = /^(api|v\d+)$/i;

// Postman-style: one folder per host ("collection"), one flat file per request,
// named after the meaningful tail of the URL path.
function deriveFromUrl(raw: string): UrlDerivation | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // A leading template variable like {{base_url}} is not a host.
  const templateLead = trimmed.match(/^\{\{\s*[^}]+\s*\}\}/);
  let host = "";
  let pathPart: string;
  if (templateLead) {
    pathPart = trimmed.slice(templateLead[0].length);
  } else {
    let candidate = trimmed;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
      candidate = `https://${candidate}`;
    }
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      return null;
    }
    host = u.host;
    pathPart = u.pathname;
  }

  const segments = pathPart
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    });
  const meaningful = segments.filter((seg) => !NOISE_RE.test(seg));
  const tail = (meaningful.length > 0 ? meaningful : segments).slice(-2);
  return { host, name: tail.length > 0 ? tail.join("/") : host || "/" };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function joinPath(folder: string, file: string): string {
  const f = folder.trim().replace(/^\/+|\/+$/g, "");
  return f ? `${f}/${file}` : file;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function NewEntryModal({
  root,
  initialKind = "request",
  initialPath = "",
  folders = [],
  onCreated,
  onCancel,
}: Props) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [folder, setFolder] = useState(initialPath.replace(/\/+$/, ""));
  const [folderEdited, setFolderEdited] = useState(initialPath !== "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const config = KINDS.find((k) => k.value === kind)!;
  const isRequest = kind === "request";
  const isFolder = kind === "folder";

  const derivation = isRequest ? deriveFromUrl(url) : null;

  useEffect(() => {
    if (!isRequest) return;
    if (!nameEdited) setName(derivation?.name ?? "");
    if (!folderEdited) setFolder(derivation?.host ?? "");
  }, [derivation?.name, derivation?.host, isRequest, nameEdited, folderEdited]);

  const requestFile = `${method.toLowerCase()}-${slugify(name) || "request"}`;
  const requestPath = joinPath(folder, requestFile);

  async function create() {
    setError(null);
    const finalPath = isRequest ? requestPath : path.trim();
    if (!finalPath) return setError("Enter a path.");
    setBusy(true);
    try {
      if (isFolder) {
        const rel = await invoke<string>("create_folder", {
          root,
          kind: "request",
          rel: finalPath,
        });
        onCreated(rel, kind);
      } else {
        const rel = await invoke<string>("create_entry", {
          root,
          kind,
          rel: finalPath,
          url: isRequest && url.trim() ? url.trim() : null,
          method: isRequest ? method : null,
          name: isRequest ? name.trim() || null : null,
        });
        onCreated(rel, kind);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") create();
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New entry</h2>

        <div className="kind-row">
          {KINDS.map((k) => (
            <button
              key={k.value}
              className={`kind-pill ${kind === k.value ? "active" : ""}`}
              onClick={() => {
                setKind(k.value);
                setError(null);
              }}
            >
              {k.label}
            </button>
          ))}
        </div>

        {isRequest ? (
          <>
            <label>
              URL <span className="modal-label-faint">(optional — you can fill it in the editor)</span>
              <div className="modal-url-row">
                <select
                  className="modal-method-select"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://fakestoreapi.com/products/1"
                  autoFocus
                  onKeyDown={onEnter}
                />
              </div>
            </label>
            <label>
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
                placeholder="List users"
                onKeyDown={onEnter}
              />
            </label>
            <label>
              Folder <span className="modal-label-faint">(like a Postman collection — empty for top level)</span>
              <input
                type="text"
                value={folder}
                list="new-entry-folders"
                onChange={(e) => {
                  setFolder(e.target.value);
                  setFolderEdited(true);
                }}
                placeholder="api.example.com"
                onKeyDown={onEnter}
              />
              <datalist id="new-entry-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <span className="modal-hint">saved as requests/{requestPath}.toml</span>
            </label>
          </>
        ) : (
          <label>
            Path
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={config.placeholder}
              autoFocus
              onKeyDown={onEnter}
            />
            <span className="modal-hint">{config.hint}</span>
          </label>
        )}

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
