import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
  vars: Record<string, string>;
  placeholder?: string;
  className?: string;
  monospace?: boolean;
}

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

interface Token {
  type: "text" | "var";
  text: string;
  name?: string;
}

function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(value)) !== null) {
    if (m.index > last) {
      tokens.push({ type: "text", text: value.slice(last, m.index) });
    }
    tokens.push({ type: "var", text: m[0], name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < value.length) {
    tokens.push({ type: "text", text: value.slice(last) });
  }
  return tokens;
}

export function TemplatedInput({
  value,
  onChange,
  vars,
  placeholder,
  className,
  monospace,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const overlay = overlayRef.current;
    if (!input || !overlay) return;
    const onScroll = () => {
      overlay.scrollLeft = input.scrollLeft;
    };
    input.addEventListener("scroll", onScroll);
    return () => input.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (overlayRef.current && inputRef.current) {
      overlayRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  }, [value]);

  const tokens = tokenize(value);
  const usedVars = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; value: string | undefined }[] = [];
    VAR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VAR_RE.exec(value)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push({ name: m[1], value: vars[m[1]] });
      }
    }
    return out;
  }, [value, vars]);

  return (
    <div className={`tmpl-input ${monospace ? "mono" : ""} ${className ?? ""}`}>
      <input
        ref={inputRef}
        className="tmpl-input-real"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        placeholder={placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      <div className="tmpl-input-overlay" ref={overlayRef} aria-hidden>
        {tokens.length === 0 && <span className="tmpl-text">{value || "​"}</span>}
        {tokens.map((tok, i) =>
          tok.type === "var" ? (
            <span
              key={i}
              className={`tmpl-var ${vars[tok.name!] !== undefined ? "defined" : "undefined"}`}
            >
              {tok.text}
            </span>
          ) : (
            <span key={i} className="tmpl-text">
              {tok.text}
            </span>
          ),
        )}
      </div>
      {focused && usedVars.length > 0 && (
        <div className="tmpl-popover" onMouseDown={(e) => e.preventDefault()}>
          {usedVars.map((v) => (
            <div className="tmpl-popover-row" key={v.name}>
              <span className="tmpl-popover-name">{`{{${v.name}}}`}</span>
              {v.value !== undefined ? (
                <span className="tmpl-popover-value">{v.value}</span>
              ) : (
                <span className="tmpl-popover-missing">not in env</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
