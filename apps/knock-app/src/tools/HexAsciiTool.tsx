import { useMemo } from "react";
import { CopyButton, HistoryList, bytesToHex, useHistory, usePersistedField } from "./shared";

type Mode = "text-to-hex" | "hex-to-text" | "text-to-bytes";

export function HexAsciiTool() {
  const [mode, setMode] = usePersistedField<Mode>("knock.tools.hexascii.mode", "text-to-hex");
  const [input, setInput] = usePersistedField<string>("knock.tools.hexascii.input", "");
  const history = useHistory("knock.tools.hexascii.history");

  const output = useMemo(() => {
    if (!input) return "";
    try {
      if (mode === "text-to-hex") {
        return bytesToHex(new TextEncoder().encode(input));
      }
      if (mode === "hex-to-text") {
        const cleaned = input.replace(/[\s,0x]/g, "");
        if (cleaned.length % 2 !== 0) throw new Error("Hex length must be even");
        const bytes = new Uint8Array(cleaned.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
        }
        return new TextDecoder().decode(bytes);
      }
      // text-to-bytes (decimal array)
      const bytes = new TextEncoder().encode(input);
      return Array.from(bytes).join(", ");
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }, [input, mode]);

  return (
    <>
      <div className="tools-tabs tools-tabs-wrap">
        {(["text-to-hex", "hex-to-text", "text-to-bytes"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => history.push(mode, input)}
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>Output</span>
        <CopyButton text={output} />
      </div>
      <textarea className="tools-textarea tools-output" value={output} readOnly spellCheck={false} />
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}
