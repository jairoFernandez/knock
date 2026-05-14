import { useEffect, useState } from "react";
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

function sanitizeSegment(seg: string): string {
  return seg
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "index";
}

const ID_RE = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;

function isIdSegment(s: string): boolean {
  return ID_RE.test(s);
}

function deriveFromUrl(raw: string, method: string): { path: string; host: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
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
  const host = u.host;
  const segments = u.pathname.split("/").filter(Boolean).map(sanitizeSegment);
  const verb = method.toLowerCase();

  if (segments.length === 0) {
    return { path: `${host}/${verb}`, host };
  }
  const last = segments[segments.length - 1];
  if (isIdSegment(last)) {
    const folders = segments.slice(0, -1).join("/");
    const folderPart = folders ? `${folders}/` : "";
    return { path: `${host}/${folderPart}${last}`, host };
  }
  const folders = segments.join("/");
  return { path: `${host}/${folders}/${verb}`, host };
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function NewEntryModal({ root, initialKind = "request", onCreated, onCancel }: Props) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const config = KINDS.find((k) => k.value === kind)!;
  const isRequest = kind === "request";

  useEffect(() => {
    if (!isRequest) return;
    if (pathEdited) return;
    const derived = deriveFromUrl(url, method);
    setPath(derived?.path ?? "");
  }, [url, method, isRequest, pathEdited]);

  async function create() {
    setError(null);
    const finalPath = path.trim();
    if (!finalPath) return setError("Enter a path (or fill the URL to auto-suggest one).");
    setBusy(true);
    try {
      const rel = await invoke<string>("create_entry", {
        root,
        kind,
        rel: finalPath,
        url: isRequest && url.trim() ? url.trim() : null,
        method: isRequest ? method : null,
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
              onClick={() => {
                setKind(k.value);
                setError(null);
              }}
            >
              {k.label}
            </button>
          ))}
        </div>

        {isRequest && (
          <label>
            URL <span className="modal-label-faint">(optional — auto-derives path)</span>
            <input
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setPathEdited(false);
              }}
              placeholder="https://fakestoreapi.com/products/1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
          </label>
        )}

        <label>
          Path
          <input
            type="text"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathEdited(true);
            }}
            placeholder={config.placeholder}
            autoFocus={!isRequest}
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
