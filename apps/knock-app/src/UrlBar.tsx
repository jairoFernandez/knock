interface Props {
  method: string;
  url: string;
  running: boolean;
  canRun: boolean;
  onRun: () => void;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function methodClass(method: string): string {
  const m = method.toUpperCase();
  if (m === "GET") return "method-get";
  if (m === "POST") return "method-post";
  if (m === "PUT") return "method-put";
  if (m === "PATCH") return "method-patch";
  if (m === "DELETE") return "method-delete";
  if (m === "HEAD" || m === "OPTIONS") return "method-head";
  return "method-any";
}

export function UrlBar({ method, url, running, canRun, onRun }: Props) {
  return (
    <div className="urlbar">
      <span className={`method-chip method-chip-lg ${methodClass(method)}`}>
        {METHODS.includes(method.toUpperCase()) ? method.toUpperCase() : (method || "—")}
      </span>
      <input className="url-input" type="text" value={url} readOnly placeholder="(URL from request body)" />
      <button className="send" disabled={!canRun || running} onClick={onRun}>
        {running ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
