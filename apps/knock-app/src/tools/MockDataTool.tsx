import { useState } from "react";
import { CopyButton, HistoryList, randomBytes, useHistory, usePersistedField } from "./shared";

type Kind = "name" | "email" | "address" | "phone" | "uuid" | "lorem" | "ipv4" | "company";

const FIRST = ["Alex", "Jordan", "Sam", "Taylor", "Casey", "Morgan", "Riley", "Quinn", "Avery", "Drew", "Jamie", "Skyler"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Lopez", "Wilson", "Anderson", "Taylor"];
const STREETS = ["Main", "Oak", "Pine", "Maple", "Cedar", "Elm", "Birch", "Walnut", "Sunset", "Park"];
const CITIES = ["Springfield", "Riverside", "Madison", "Georgetown", "Franklin", "Clinton", "Greenville", "Bristol"];
const COMPANIES = ["Acme", "Globex", "Initech", "Umbrella", "Vandelay", "Stark", "Wayne", "Hooli", "Pied Piper", "Wonka"];
const SUFFIX = ["Inc", "LLC", "Corp", "Group", "Labs", "Co"];

const LOREM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.`;

export function MockDataTool() {
  const [kind, setKind] = usePersistedField<Kind>("knock.tools.mock.kind", "name");
  const [count, setCount] = usePersistedField<number>("knock.tools.mock.count", 5);
  const [output, setOutput] = useState("");
  const history = useHistory("knock.tools.mock.history");

  function gen() {
    const arr: string[] = [];
    for (let i = 0; i < count; i++) arr.push(genOne(kind));
    const v = arr.join("\n");
    setOutput(v);
    history.push(kind, v);
  }

  return (
    <>
      <div className="tools-tabs tools-tabs-wrap">
        {(["name", "email", "address", "phone", "uuid", "lorem", "ipv4", "company"] as Kind[]).map((k) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
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

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function genOne(kind: Kind): string {
  if (kind === "name") return `${pick(FIRST)} ${pick(LAST)}`;
  if (kind === "email") {
    const first = pick(FIRST).toLowerCase();
    const last = pick(LAST).toLowerCase();
    const domain = pick(["example.com", "test.org", "mail.net", "demo.io"]);
    return `${first}.${last}${Math.floor(Math.random() * 99)}@${domain}`;
  }
  if (kind === "address") {
    return `${Math.floor(Math.random() * 9999) + 1} ${pick(STREETS)} St, ${pick(CITIES)}`;
  }
  if (kind === "phone") {
    const n = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
    return `+1 (${n(200, 999)}) ${n(200, 999)}-${n(1000, 9999)}`;
  }
  if (kind === "uuid") {
    if ("randomUUID" in crypto) return crypto.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (kind === "ipv4") {
    return [1, 2, 3, 4].map(() => Math.floor(Math.random() * 256)).join(".");
  }
  if (kind === "company") return `${pick(COMPANIES)} ${pick(SUFFIX)}`;
  // lorem
  const words = LOREM.split(/\s+/);
  const len = 8 + Math.floor(Math.random() * 25);
  return words.slice(0, len).join(" ");
}
