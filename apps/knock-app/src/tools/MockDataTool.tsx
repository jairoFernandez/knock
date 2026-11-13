import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CopyButton, HistoryList, useHistory, usePersistedField } from "./shared";

type Kind =
  | "name"
  | "email"
  | "address"
  | "phone"
  | "uuid"
  | "lorem"
  | "ipv4"
  | "company"
  | "user"
  | "template";

const KINDS: Kind[] = ["name", "email", "address", "phone", "uuid", "lorem", "ipv4", "company", "user", "template"];

// Same token engine the mock server uses, so what you see here is what endpoints return.
const TEMPLATES: Record<Exclude<Kind, "template">, string> = {
  name: "{{name.full}}",
  email: "{{internet.free_email}}",
  address: "{{address.street}}, {{address.city}} {{address.zip}}, {{address.country}}",
  phone: "{{phone}}",
  uuid: "{{uuid}}",
  lorem: "{{lorem.sentence}}",
  ipv4: "{{internet.ipv4}}",
  company: "{{company.name}}",
  user: '{\n  "id": "{{uuid}}",\n  "name": "{{name.full}}",\n  "email": "{{internet.email}}",\n  "username": "{{internet.username}}",\n  "password": "{{string.password(16)}}",\n  "createdAt": "{{date.past(90)}}"\n}',
};

const DEFAULT_TEMPLATE = '{\n  "id": "{{uuid}}",\n  "sku": "SKU-{{string.upper(3)}}-{{string.numeric(4)}}",\n  "price": "{{number.float(1..100)}}",\n  "inStock": "{{bool}}"\n}';

interface MockToken {
  token: string;
  description: string;
  group: string;
  snippet: string | null;
}

export function MockDataTool() {
  const [kind, setKind] = usePersistedField<Kind>("knock.tools.mock.kind", "name");
  const [count, setCount] = usePersistedField<number>("knock.tools.mock.count", 5);
  const [template, setTemplate] = usePersistedField<string>("knock.tools.mock.template", DEFAULT_TEMPLATE);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<MockToken[]>([]);
  const templateRef = useRef<HTMLTextAreaElement | null>(null);
  const history = useHistory("knock.tools.mock.history");

  useEffect(() => {
    invoke<MockToken[]>("mock_token_catalog")
      // Request tokens only make sense inside a live mock endpoint.
      .then((all) => setTokens(all.filter((t) => t.group !== "Request")))
      .catch(() => setTokens([]));
  }, []);

  async function gen() {
    setError(null);
    try {
      const tpl = kind === "template" ? template : TEMPLATES[kind];
      const v = await invoke<string>("mock_render_template", { template: tpl, count });
      setOutput(v);
      history.push(kind, v);
    } catch (e) {
      setError(String(e));
    }
  }

  function insert(t: MockToken) {
    const el = templateRef.current;
    const start = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? template.length;
    const text = t.snippet ?? t.token;
    setTemplate(template.slice(0, start) + text + template.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return (
    <>
      <div className="tools-tabs tools-tabs-wrap">
        {KINDS.map((k) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      {kind === "template" && (
        <>
          <div className="tools-row">
            <label className="tools-label" style={{ flex: 1 }}>
              Template — JSON gives an array, plain text one line per item
            </label>
            <select
              className="tools-input"
              value=""
              onChange={(e) => {
                const t = tokens.find((x) => x.token === e.target.value);
                if (t) insert(t);
              }}
            >
              <option value="">Insert token…</option>
              {Array.from(new Set(tokens.map((t) => t.group))).map((g) => (
                <optgroup key={g} label={g}>
                  {tokens
                    .filter((t) => t.group === g)
                    .map((t) => (
                      <option key={t.token} value={t.token}>
                        {t.token} — {t.description}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <textarea
            ref={templateRef}
            className="tools-textarea"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            spellCheck={false}
            rows={8}
          />
        </>
      )}
      <div className="tools-row">
        <label className="tools-label" style={{ flex: 1 }}>
          Count
        </label>
        <input
          type="number"
          className="tools-input"
          min={1}
          max={500}
          value={count}
          onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
        />
      </div>
      <button className="tools-generate" onClick={gen}>
        Generate
      </button>
      {error && <div className="tools-error">{error}</div>}
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      <textarea
        className="tools-textarea tools-output tools-textarea-tall"
        value={output}
        readOnly
        spellCheck={false}
      />
      <HistoryList history={history} onPick={setOutput} />
    </>
  );
}
