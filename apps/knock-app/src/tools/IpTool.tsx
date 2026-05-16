import { useMemo } from "react";
import { CopyInline, HistoryList, useHistory, usePersistedField } from "./shared";

export function IpTool() {
  const [input, setInput] = usePersistedField<string>("knock.tools.ip.input", "");
  const history = useHistory("knock.tools.ip.history");

  const parsed = useMemo(() => parseInput(input.trim()), [input]);

  return (
    <>
      <label className="tools-label">IP / CIDR (v4 only)</label>
      <input
        type="text"
        className="tools-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => history.push("ip", input)}
        placeholder="192.168.1.0/24 or 10.0.0.5"
        spellCheck={false}
      />
      {input && !parsed && <div className="tools-error">Invalid IPv4 or CIDR</div>}
      {parsed && (
        <div className="tools-date-grid">
          <span>Address</span>
          <span className="tools-mono">
            {parsed.addr}
            <CopyInline text={parsed.addr} />
          </span>
          <span>Decimal</span>
          <span className="tools-mono">{parsed.dec}</span>
          <span>Binary</span>
          <span className="tools-mono">{parsed.bin}</span>
          <span>Hex</span>
          <span className="tools-mono">{parsed.hex}</span>
          {parsed.prefix !== null && (
            <>
              <span>Prefix</span>
              <span className="tools-mono">/{parsed.prefix}</span>
              <span>Mask</span>
              <span className="tools-mono">{parsed.mask}</span>
              <span>Wildcard</span>
              <span className="tools-mono">{parsed.wildcard}</span>
              <span>Network</span>
              <span className="tools-mono">
                {parsed.network}
                <CopyInline text={parsed.network!} />
              </span>
              <span>Broadcast</span>
              <span className="tools-mono">
                {parsed.broadcast}
                <CopyInline text={parsed.broadcast!} />
              </span>
              <span>First host</span>
              <span className="tools-mono">{parsed.firstHost}</span>
              <span>Last host</span>
              <span className="tools-mono">{parsed.lastHost}</span>
              <span>Hosts</span>
              <span className="tools-mono">{parsed.hosts}</span>
            </>
          )}
        </div>
      )}
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

function parseInput(s: string) {
  if (!s) return null;
  const [addrPart, prefixPart] = s.split("/");
  const addr = parseIpv4(addrPart);
  if (addr === null) return null;
  const prefix = prefixPart !== undefined ? Number(prefixPart) : null;
  if (prefix !== null && (!Number.isInteger(prefix) || prefix < 0 || prefix > 32)) return null;

  const ipStr = formatIpv4(addr);
  const base = {
    addr: ipStr,
    dec: String(addr >>> 0),
    bin: addr.toString(2).padStart(32, "0").replace(/(.{8})/g, "$1.").slice(0, -1),
    hex: "0x" + (addr >>> 0).toString(16).padStart(8, "0"),
    prefix,
    mask: null as string | null,
    wildcard: null as string | null,
    network: null as string | null,
    broadcast: null as string | null,
    firstHost: null as string | null,
    lastHost: null as string | null,
    hosts: null as string | null,
  };
  if (prefix === null) return base;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (addr & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = 2 ** (32 - prefix);
  const hosts = prefix >= 31 ? total : total - 2;
  return {
    ...base,
    mask: formatIpv4(mask),
    wildcard: formatIpv4(~mask >>> 0),
    network: formatIpv4(network),
    broadcast: formatIpv4(broadcast),
    firstHost: prefix >= 31 ? formatIpv4(network) : formatIpv4(network + 1),
    lastHost: prefix >= 31 ? formatIpv4(broadcast) : formatIpv4(broadcast - 1),
    hosts: String(hosts),
  };
}

function parseIpv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n;
}

function formatIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}
