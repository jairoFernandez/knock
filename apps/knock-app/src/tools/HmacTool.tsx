import { useEffect, useState } from "react";
import {
  CopyButton,
  HistoryList,
  b64UrlEncodeBytes,
  bytesToHex,
  padBase64,
  useHistory,
  usePersistedField,
} from "./shared";

type Algo = "SHA-256" | "SHA-384" | "SHA-512" | "SHA-1";
type Output = "hex" | "base64" | "base64url";

const ALGOS: Algo[] = ["SHA-256", "SHA-384", "SHA-512", "SHA-1"];

export function HmacTool() {
  const [text, setText] = usePersistedField<string>("knock.tools.hmac.input", "");
  const [secret, setSecret] = usePersistedField<string>("knock.tools.hmac.secret", "");
  const [secretIsBase64, setSecretIsBase64] = usePersistedField<boolean>(
    "knock.tools.hmac.secretB64",
    false,
  );
  const [algo, setAlgo] = usePersistedField<Algo>("knock.tools.hmac.algo", "SHA-256");
  const [output, setOutput] = usePersistedField<Output>("knock.tools.hmac.output", "hex");
  const [result, setResult] = useState("");
  const history = useHistory("knock.tools.hmac.history");

  useEffect(() => {
    let active = true;
    (async () => {
      if (!text || !secret) {
        if (active) setResult("");
        return;
      }
      try {
        let keyBytes: Uint8Array;
        if (secretIsBase64) {
          const padded = padBase64(secret).replace(/-/g, "+").replace(/_/g, "/");
          const bin = atob(padded);
          keyBytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
        } else {
          keyBytes = new TextEncoder().encode(secret);
        }
        const key = await crypto.subtle.importKey(
          "raw",
          keyBytes as BufferSource,
          { name: "HMAC", hash: algo },
          false,
          ["sign"],
        );
        const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
        const bytes = new Uint8Array(sig);
        let out = "";
        if (output === "hex") out = bytesToHex(bytes);
        else if (output === "base64") {
          let bin = "";
          for (const b of bytes) bin += String.fromCharCode(b);
          out = btoa(bin);
        } else out = b64UrlEncodeBytes(bytes);
        if (active) setResult(out);
      } catch (e) {
        if (active) setResult(`Error: ${String(e)}`);
      }
    })();
    return () => {
      active = false;
    };
  }, [text, secret, secretIsBase64, algo, output]);

  return (
    <>
      <div className="tools-tabs tools-tabs-wrap">
        {ALGOS.map((a) => (
          <button key={a} className={algo === a ? "active" : ""} onClick={() => setAlgo(a)}>
            {a.replace("SHA-", "HS")}
          </button>
        ))}
      </div>
      <label className="tools-label">Message</label>
      <textarea
        className="tools-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => history.push("msg", text)}
        spellCheck={false}
        placeholder="Payload to sign"
      />
      <div className="tools-output-header">
        <span>Secret</span>
        <label className="tools-checkbox">
          <input
            type="checkbox"
            checked={secretIsBase64}
            onChange={(e) => setSecretIsBase64(e.target.checked)}
          />
          base64
        </label>
      </div>
      <input
        type="text"
        className="tools-input"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="HMAC secret"
        spellCheck={false}
      />
      <div className="tools-tabs">
        {(["hex", "base64", "base64url"] as Output[]).map((o) => (
          <button key={o} className={output === o ? "active" : ""} onClick={() => setOutput(o)}>
            {o}
          </button>
        ))}
      </div>
      <div className="tools-output-header">
        <span>Signature</span>
        <CopyButton text={result} />
      </div>
      <pre className="tools-pre">{result}</pre>
      <HistoryList history={history} onPick={setText} />
    </>
  );
}
