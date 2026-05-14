import type { ResponseDto } from "./types";

interface Props {
  response: ResponseDto;
}

export function ResponseView({ response }: Props) {
  const isOk = response.status >= 200 && response.status < 400;
  const codeClass = isOk ? "ok" : "err";
  const pretty = formatBody(response);

  return (
    <>
      <div className="status">
        <span className={`code ${codeClass}`}>{response.status}</span>
        <span style={{ color: "var(--text-dim)" }}>
          {response.method} {response.url}
        </span>
        <span style={{ color: "var(--text-faint)", marginLeft: 8 }}>
          {response.elapsedMs} ms
        </span>
      </div>
      <details>
        <summary>Headers · {response.headers.length}</summary>
        <pre>
          {response.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}
        </pre>
      </details>
      <pre>{pretty}</pre>
    </>
  );
}

function formatBody(response: ResponseDto): string {
  const contentType =
    response.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }
  return response.body;
}
