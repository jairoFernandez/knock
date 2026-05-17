import { useLayoutEffect, useMemo, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { BodyForm, KV, MultipartField } from "./types";
import { highlightJson } from "./jsonHighlight";
import { KVTable } from "./KVTable";

interface Props {
  body: BodyForm;
  vars: Record<string, string>;
  onChange: (next: BodyForm) => void;
}

const KINDS: { value: BodyForm["kind"]; label: string }[] = [
  { value: "none", label: "No body" },
  { value: "text", label: "Text" },
  { value: "json", label: "JSON" },
  { value: "form", label: "Form" },
  { value: "multipart", label: "Multipart" },
  { value: "file", label: "File" },
];

export function BodyTab({ body, vars, onChange }: Props) {
  function setKind(kind: BodyForm["kind"]) {
    switch (kind) {
      case "none":
        return onChange({ kind: "none" });
      case "text":
        return onChange({
          kind: "text",
          text: body.kind === "text" ? body.text : "",
        });
      case "json":
        return onChange({
          kind: "json",
          json: body.kind === "json" ? body.json : "{\n  \n}",
        });
      case "form":
        return onChange({
          kind: "form",
          form: body.kind === "form" ? body.form : [],
        });
      case "file":
        return onChange({
          kind: "file",
          path: body.kind === "file" ? body.path : "",
        });
      case "multipart":
        return onChange({
          kind: "multipart",
          multipart: body.kind === "multipart" ? body.multipart : [],
        });
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
        <JsonBodyEditor
          value={body.json}
          onChange={(json) => onChange({ kind: "json", json })}
        />
      )}

      {body.kind === "form" && (
        <FormBodyEditor
          rows={body.form}
          vars={vars}
          onChange={(form) => onChange({ kind: "form", form })}
        />
      )}

      {body.kind === "file" && (
        <FileBodyEditor
          path={body.path}
          onChange={(path) => onChange({ kind: "file", path })}
        />
      )}

      {body.kind === "multipart" && (
        <MultipartBodyEditor
          fields={body.multipart}
          onChange={(multipart) => onChange({ kind: "multipart", multipart })}
        />
      )}
    </div>
  );
}

function MultipartBodyEditor({
  fields,
  onChange,
}: {
  fields: MultipartField[];
  onChange: (next: MultipartField[]) => void;
}) {
  function set(i: number, next: MultipartField) {
    onChange(fields.map((f, j) => (j === i ? next : f)));
  }
  function remove(i: number) {
    onChange(fields.filter((_, j) => j !== i));
  }
  function add(kind: "text" | "file") {
    onChange([...fields, { name: "", value: "", kind }]);
  }
  async function pick(i: number) {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") set(i, { ...fields[i], value: picked });
  }
  return (
    <div className="body-form-wrap">
      <div className="body-form-hint">
        Sent as <code>multipart/form-data</code>. File fields upload the picked file.
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {fields.map((f, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "70px 180px 1fr 80px 24px",
              gap: 6,
              padding: "4px 6px",
              borderBottom: "1px solid var(--border)",
              alignItems: "center",
            }}
          >
            <select
              value={f.kind}
              onChange={(e) =>
                set(i, { ...f, kind: e.target.value as "text" | "file" })
              }
              style={{ fontSize: 11 }}
            >
              <option value="text">text</option>
              <option value="file">file</option>
            </select>
            <input
              type="text"
              value={f.name}
              placeholder="field name"
              onChange={(e) => set(i, { ...f, name: e.target.value })}
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", fontSize: 12 }}
            />
            <input
              type="text"
              value={f.value}
              placeholder={f.kind === "file" ? "/path/to/file" : "value"}
              onChange={(e) => set(i, { ...f, value: e.target.value })}
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", fontSize: 12 }}
            />
            {f.kind === "file" ? (
              <button type="button" onClick={() => pick(i)}>
                Browse…
              </button>
            ) : (
              <span />
            )}
            <button type="button" onClick={() => remove(i)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div style={{ padding: 6, display: "flex", gap: 6 }}>
        <button type="button" onClick={() => add("text")}>
          + Text field
        </button>
        <button type="button" onClick={() => add("file")}>
          + File field
        </button>
      </div>
    </div>
  );
}

function JsonBodyEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });

  const parseError = useMemo(() => {
    if (!value.trim()) return null;
    try {
      JSON.parse(value);
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  }, [value]);

  function format() {
    try {
      const pretty = JSON.stringify(JSON.parse(value), null, 2);
      onChange(pretty);
    } catch {
      /* noop */
    }
  }

  function minify() {
    try {
      const tight = JSON.stringify(JSON.parse(value));
      onChange(tight);
    } catch {
      /* noop */
    }
  }

  return (
    <div className="body-json-wrap">
      <div className="body-json-toolbar">
        <span className={`body-json-status ${parseError ? "err" : "ok"}`}>
          {parseError ? "✗ invalid" : value.trim() ? "✓ valid" : "empty"}
        </span>
        <div className="body-json-actions">
          <button type="button" onClick={format} disabled={!!parseError || !value.trim()}>
            Format
          </button>
          <button type="button" onClick={minify} disabled={!!parseError || !value.trim()}>
            Minify
          </button>
        </div>
      </div>
      <div className="code-editor body-json-editor">
        <pre ref={preRef} className="code-editor-pre" aria-hidden="true">
          <code
            dangerouslySetInnerHTML={{ __html: highlightJson(value) + "\n" }}
          />
        </pre>
        <textarea
          ref={taRef}
          className="code-editor-ta"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            const pre = preRef.current;
            if (!pre) return;
            pre.scrollTop = e.currentTarget.scrollTop;
            pre.scrollLeft = e.currentTarget.scrollLeft;
          }}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder='{"key": "value"}'
        />
      </div>
      {parseError && <div className="body-json-err">{parseError}</div>}
    </div>
  );
}

function FormBodyEditor({
  rows,
  vars,
  onChange,
}: {
  rows: KV[];
  vars: Record<string, string>;
  onChange: (next: KV[]) => void;
}) {
  return (
    <div className="body-form-wrap">
      <div className="body-form-hint">
        Sent as <code>application/x-www-form-urlencoded</code>. Add a Content-Type header to override.
      </div>
      <KVTable rows={rows} vars={vars} keyPlaceholder="field" onChange={onChange} />
    </div>
  );
}

function FileBodyEditor({
  path,
  onChange,
}: {
  path: string;
  onChange: (next: string) => void;
}) {
  async function pickFile() {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") onChange(picked);
  }

  return (
    <div className="body-file-wrap">
      <div className="body-file-row">
        <input
          className="body-file"
          type="text"
          value={path}
          onChange={(e) => onChange(e.target.value)}
          placeholder="./relative/path/to/body.json"
        />
        <button type="button" onClick={pickFile}>Browse…</button>
      </div>
      <div className="body-file-hint">
        Path is resolved relative to the request file. Absolute paths also work.
      </div>
    </div>
  );
}
