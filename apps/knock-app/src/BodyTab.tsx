import type { BodyForm } from "./types";

interface Props {
  body: BodyForm;
  onChange: (next: BodyForm) => void;
}

const KINDS: { value: BodyForm["kind"]; label: string }[] = [
  { value: "none", label: "No body" },
  { value: "text", label: "Text" },
  { value: "json", label: "JSON" },
  { value: "file", label: "File" },
];

export function BodyTab({ body, onChange }: Props) {
  function setKind(kind: BodyForm["kind"]) {
    switch (kind) {
      case "none": return onChange({ kind: "none" });
      case "text": return onChange({ kind: "text", text: body.kind === "text" ? body.text : "" });
      case "json": return onChange({
        kind: "json",
        json: body.kind === "json" ? body.json : "{\n  \n}",
      });
      case "file": return onChange({ kind: "file", path: body.kind === "file" ? body.path : "" });
    }
  }

  return (
    <div className="body-tab">
      <div className="body-kind-row">
        {KINDS.map((k) => (
          <label key={k.value} className="body-kind-option">
            <input
              type="radio"
              checked={body.kind === k.value}
              onChange={() => setKind(k.value)}
            />
            <span>{k.label}</span>
          </label>
        ))}
      </div>

      {body.kind === "none" && (
        <div className="empty">This request has no body.</div>
      )}

      {body.kind === "text" && (
        <textarea
          className="body-textarea"
          value={body.text}
          onChange={(e) => onChange({ kind: "text", text: e.target.value })}
          placeholder="Raw body text…"
          spellCheck={false}
        />
      )}

      {body.kind === "json" && (
        <textarea
          className="body-textarea body-json"
          value={body.json}
          onChange={(e) => onChange({ kind: "json", json: e.target.value })}
          placeholder='{"key": "value"}'
          spellCheck={false}
        />
      )}

      {body.kind === "file" && (
        <input
          className="body-file"
          type="text"
          value={body.path}
          onChange={(e) => onChange({ kind: "file", path: e.target.value })}
          placeholder="./relative/path/to/body.json"
        />
      )}
    </div>
  );
}
