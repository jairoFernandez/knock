import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
  start: number;
  end: number;
}

function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(value)) !== null) {
    if (m.index > last) {
      tokens.push({ type: "text", text: value.slice(last, m.index), start: last, end: m.index });
    }
    tokens.push({
      type: "var",
      text: m[0],
      name: m[1],
      start: m.index,
      end: m.index + m[0].length,
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) {
    tokens.push({ type: "text", text: value.slice(last), start: last, end: value.length });
  }
  return tokens;
}

export function TemplatedInput({ value, onChange, vars, placeholder, className, monospace }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ name: string; value: string | undefined; x: number; y: number } | null>(null);

  // Keep overlay scroll synced with input scroll
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

  return (
    <div className={`tmpl-input ${monospace ? "mono" : ""} ${className ?? ""}`}>
      <input
        ref={inputRef}
        className="tmpl-input-real"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onMouseLeave={() => setTooltip(null)}
      />
      <div className="tmpl-input-overlay" ref={overlayRef} aria-hidden>
        {tokens.length === 0 && (
          <span className="tmpl-text">{value || "​"}</span>
        )}
        {tokens.map((tok, i) =>
          tok.type === "var" ? (
            <span
              key={i}
              className={`tmpl-var ${vars[tok.name!] !== undefined ? "defined" : "undefined"}`}
              onMouseEnter={(e) => {
                const rect = (e.target as HTMLElement).getBoundingClientRect();
                setTooltip({
                  name: tok.name!,
                  value: vars[tok.name!],
                  x: rect.left + rect.width / 2,
                  y: rect.top,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              {tok.text}
            </span>
          ) : (
            <span key={i} className="tmpl-text">{tok.text}</span>
          ),
        )}
      </div>
      {tooltip && (
        <div
          className="tmpl-tooltip"
          style={{ left: tooltip.x, top: tooltip.y - 8 }}
        >
          <span className="tmpl-tooltip-name">{tooltip.name}</span>
          {tooltip.value !== undefined ? (
            <span className="tmpl-tooltip-value">{tooltip.value}</span>
          ) : (
            <span className="tmpl-tooltip-missing">not defined in env</span>
          )}
        </div>
      )}
    </div>
  );
}
