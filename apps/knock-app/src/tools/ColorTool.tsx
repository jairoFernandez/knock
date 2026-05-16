import { useMemo } from "react";
import { CopyInline, HistoryList, useHistory, usePersistedField } from "./shared";

export function ColorTool() {
  const [input, setInput] = usePersistedField<string>("knock.tools.color.input", "#3366ff");
  const history = useHistory("knock.tools.color.history");

  const parsed = useMemo(() => parseColor(input.trim()), [input]);

  return (
    <>
      <label className="tools-label">Color (hex, rgb, hsl)</label>
      <div className="tools-row">
        <input
          type="text"
          className="tools-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => history.push("color", input)}
          placeholder="#3366ff or rgb(51, 102, 255)"
          spellCheck={false}
          style={{ flex: 1 }}
        />
        <input
          type="color"
          value={parsed ? rgbToHex(parsed.r, parsed.g, parsed.b) : "#000000"}
          onChange={(e) => setInput(e.target.value)}
          className="tools-color-picker"
        />
      </div>
      {input && !parsed && <div className="tools-error">Could not parse color</div>}
      {parsed && (
        <>
          <div
            className="tools-color-swatch"
            style={{ background: `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${parsed.a})` }}
          />
          <div className="tools-date-grid">
            <span>Hex</span>
            <span className="tools-mono">
              {rgbToHex(parsed.r, parsed.g, parsed.b)}
              <CopyInline text={rgbToHex(parsed.r, parsed.g, parsed.b)} />
            </span>
            <span>Hex+alpha</span>
            <span className="tools-mono">
              {rgbToHex(parsed.r, parsed.g, parsed.b) +
                Math.round(parsed.a * 255)
                  .toString(16)
                  .padStart(2, "0")}
            </span>
            <span>RGB</span>
            <span className="tools-mono">
              rgb({parsed.r}, {parsed.g}, {parsed.b})
              <CopyInline text={`rgb(${parsed.r}, ${parsed.g}, ${parsed.b})`} />
            </span>
            <span>RGBA</span>
            <span className="tools-mono">
              rgba({parsed.r}, {parsed.g}, {parsed.b}, {parsed.a})
            </span>
            <span>HSL</span>
            <span className="tools-mono">
              {hslStr(rgbToHsl(parsed.r, parsed.g, parsed.b))}
              <CopyInline text={hslStr(rgbToHsl(parsed.r, parsed.g, parsed.b))} />
            </span>
          </div>
        </>
      )}
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(s: string): Rgba | null {
  if (!s) return null;
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a };
    }
    return null;
  }
  const rgbM = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
  if (rgbM) {
    return { r: +rgbM[1], g: +rgbM[2], b: +rgbM[3], a: rgbM[4] ? +rgbM[4] : 1 };
  }
  const hslM = s.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*(?:,\s*([\d.]+))?\s*\)$/i);
  if (hslM) {
    const [r, g, b] = hslToRgb(+hslM[1], +hslM[2] / 100, +hslM[3] / 100);
    return { r, g, b, a: hslM[4] ? +hslM[4] : 1 };
  }
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;
  let r: number, g: number, b: number;
  if (s === 0) r = g = b = l;
  else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hslStr([h, s, l]: [number, number, number]): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}
