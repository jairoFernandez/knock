import { useMemo, useState } from "react";
import type { ResponseDto } from "./types";
import { statusClass, statusText } from "./statusText";

interface Props {
  response: ResponseDto;
}

type Tab = "body" | "headers" | "info";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeUtf8(b64: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(b64));
  } catch {
    return "";
  }
}

function bareContentType(ct: string): string {
  return ct.split(";")[0].trim().toLowerCase();
}

function isImage(ct: string): boolean {
  return bareContentType(ct).startsWith("image/");
}

function isText(ct: string): boolean {
  const bare = bareContentType(ct);
  return (
    bare.startsWith("text/") ||
    bare === "application/json" ||
    bare === "application/xml" ||
    bare === "application/javascript" ||
    bare === "application/x-www-form-urlencoded" ||
    bare.endsWith("+json") ||
    bare.endsWith("+xml")
  );
}

export function ResponseView({ response }: Props) {
  const [tab, setTab] = useState<Tab>("body");
  const [viewMode, setViewMode] = useState<"auto" | "text" | "raw">("auto");
  const contentType = useMemo(
    () => response.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "",
    [response],
  );
  const size = useMemo(() => byteSize(response.bodyBase64), [response.bodyBase64]);

  return (
    <div className="response-view">
      <div className="resp-statusline">
        <span className={`resp-code ${statusClass(response.status)}`}>{response.status}</span>
        <span className="resp-text">{statusText(response.status)}</span>
        <span className="resp-meta">{response.elapsedMs} ms · {size}</span>
      </div>

      <div className="tab-strip">
        <button className={tab === "body" ? "tab active" : "tab"} onClick={() => setTab("body")}>
          Body
        </button>
        <button className={tab === "headers" ? "tab active" : "tab"} onClick={() => setTab("headers")}>
          Headers <span className="badge">{response.headers.length}</span>
        </button>
        <button className={tab === "info" ? "tab active" : "tab"} onClick={() => setTab("info")}>
          Info
        </button>

        {tab === "body" && (
          <div className="view-mode-toggle">
            <button
              className={viewMode === "auto" ? "active" : ""}
              onClick={() => setViewMode("auto")}
              title="Auto: render image/json/text"
            >
              Auto
            </button>
            <button
              className={viewMode === "text" ? "active" : ""}
              onClick={() => setViewMode("text")}
              title="Force text decode"
            >
              Text
            </button>
            <button
              className={viewMode === "raw" ? "active" : ""}
              onClick={() => setViewMode("raw")}
              title="Raw base64"
            >
              Raw
            </button>
          </div>
        )}
      </div>

      <div className="tab-body resp-tab-body">
        {tab === "body" && (
          <BodyPane response={response} contentType={contentType} mode={viewMode} />
        )}
        {tab === "headers" && <HeadersPane response={response} />}
        {tab === "info" && <InfoPane response={response} contentType={contentType} size={size} />}
      </div>
    </div>
  );
}

interface BodyPaneProps {
  response: ResponseDto;
  contentType: string;
  mode: "auto" | "text" | "raw";
}

function BodyPane({ response, contentType, mode }: BodyPaneProps) {
  if (mode === "raw") {
    return <pre className="raw-base64">{response.bodyBase64}</pre>;
  }

  if (mode === "auto" && isImage(contentType)) {
    const ct = bareContentType(contentType);
    return (
      <div className="image-body">
        <img
          src={`data:${ct};base64,${response.bodyBase64}`}
          alt="Response image"
        />
        <div className="image-meta">
          <span>{ct}</span>
        </div>
      </div>
    );
  }

  if (mode === "auto" && !isText(contentType) && contentType !== "") {
    return (
      <div className="binary-body">
        <div className="binary-icon">⌀</div>
        <div className="binary-text">
          <div>Binary response · {bareContentType(contentType)}</div>
          <div className="binary-hint">Switch to Raw to see the base64.</div>
        </div>
      </div>
    );
  }

  const text = decodeUtf8(response.bodyBase64);
  if (bareContentType(contentType) === "application/json" || bareContentType(contentType).endsWith("+json")) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return <pre className="json-body" dangerouslySetInnerHTML={{ __html: highlightJson(pretty) }} />;
    } catch {
      /* fall through */
    }
  }
  return <pre>{text}</pre>;
}

function HeadersPane({ response }: { response: ResponseDto }) {
  return (
    <div className="resp-headers">
      {response.headers.map(([k, v], i) => (
        <div className="resp-header-row" key={i}>
          <span className="resp-header-key">{k}</span>
          <span className="resp-header-value">{v}</span>
        </div>
      ))}
    </div>
  );
}

function InfoPane({
  response,
  contentType,
  size,
}: {
  response: ResponseDto;
  contentType: string;
  size: string;
}) {
  const rows: [string, string][] = [
    ["Status", `${response.status} ${statusText(response.status)}`],
    ["Method", response.method],
    ["URL", response.url],
    ["Elapsed", `${response.elapsedMs} ms`],
    ["Content-Type", contentType || "(none)"],
    ["Body size", size],
  ];
  return (
    <div className="resp-info">
      {rows.map(([k, v], i) => (
        <div className="info-row" key={i}>
          <span className="info-key">{k}</span>
          <span className="info-value">{v}</span>
        </div>
      ))}
    </div>
  );
}

function byteSize(b64: string): string {
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightJson(json: string): string {
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}
