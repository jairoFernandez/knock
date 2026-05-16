import type { ComponentType } from "react";
import { HashTool } from "./HashTool";
import { HmacTool } from "./HmacTool";
import { JsonTool } from "./JsonTool";
import { UrlParserTool } from "./UrlParserTool";
import { RegexTool } from "./RegexTool";
import { NumberBaseTool } from "./NumberBaseTool";
import { HexAsciiTool } from "./HexAsciiTool";
import { DiffTool } from "./DiffTool";
import { CurlTool } from "./CurlTool";
import { IpTool } from "./IpTool";
import { CronTool } from "./CronTool";
import { UserAgentTool } from "./UserAgentTool";
import { MockDataTool } from "./MockDataTool";
import { ColorTool } from "./ColorTool";
import { UnitTool } from "./UnitTool";
import { GraphqlTool } from "./GraphqlTool";
import { JwkTool } from "./JwkTool";

export type ToolKey =
  | "dashboard"
  | "base64"
  | "jwt"
  | "url"
  | "random"
  | "date"
  | "hash"
  | "hmac"
  | "json"
  | "urlparse"
  | "regex"
  | "numbase"
  | "hexascii"
  | "diff"
  | "curl"
  | "ip"
  | "cron"
  | "ua"
  | "mock"
  | "color"
  | "unit"
  | "gql"
  | "jwk";

export type GroupKey =
  | "encoding"
  | "crypto"
  | "parsing"
  | "text"
  | "generation"
  | "network"
  | "time"
  | "conversion";

export interface ToolDef {
  key: ToolKey;
  title: string;
  short: string; // 2-3 char rail label
  group: GroupKey;
  description: string;
  Component?: ComponentType;
}

export const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "encoding", label: "Encoding" },
  { key: "crypto", label: "Crypto / Auth" },
  { key: "parsing", label: "Parsing" },
  { key: "text", label: "Text / Code" },
  { key: "generation", label: "Generators" },
  { key: "network", label: "Network" },
  { key: "time", label: "Time" },
  { key: "conversion", label: "Conversion" },
];

// External components (Base64, JWT, URL, Random, Date) live in ToolsPanel.tsx still — registered
// in builtin section there. Registry only carries metadata for them; ToolsPanel handles dispatch.
export const TOOLS: ToolDef[] = [
  {
    key: "base64",
    title: "Base64",
    short: "B64",
    group: "encoding",
    description:
      "Encode text to base64 or decode base64 back to text. Accepts URL-safe (-_) variants and missing padding. UTF-8 safe.",
  },
  {
    key: "url",
    title: "URL encode",
    short: "URL",
    group: "encoding",
    description:
      "encodeURIComponent / decodeURIComponent. Useful for query strings, redirect URIs, signed URLs.",
  },
  {
    key: "hexascii",
    title: "Hex / ASCII",
    short: "0x",
    group: "encoding",
    description:
      "Convert text↔hex, hex→text, text→decimal byte array. Strips whitespace, commas, and 0x prefixes when decoding.",
    Component: HexAsciiTool,
  },

  {
    key: "jwt",
    title: "JWT",
    short: "JWT",
    group: "crypto",
    description:
      "Decode JWTs (colored header/payload/signature), edit JSON parts to re-sign with HMAC HS256/384/512, or use alg=none. Translates exp/iat/nbf to readable dates with quick-set buttons. Secret accepts raw or base64.",
  },
  {
    key: "hash",
    title: "Hash",
    short: "#",
    group: "crypto",
    description:
      "Compute MD5, SHA-1, SHA-256, SHA-384, SHA-512 of input simultaneously. MD5 in pure JS, SHA via Web Crypto.",
    Component: HashTool,
  },
  {
    key: "hmac",
    title: "HMAC",
    short: "HM",
    group: "crypto",
    description:
      "HMAC sign with SHA-1/256/384/512. Secret as raw string or base64. Output hex, base64, or base64url. Useful for webhook signatures (Stripe, GitHub).",
    Component: HmacTool,
  },
  {
    key: "jwk",
    title: "JWK / PEM",
    short: "JK",
    group: "crypto",
    description:
      "Convert JWK to PEM (RSA public, builds proper DER SubjectPublicKeyInfo). PEM body inspection is limited — full ASN.1 parsing not implemented.",
    Component: JwkTool,
  },

  {
    key: "json",
    title: "JSON",
    short: "{}",
    group: "parsing",
    description:
      "Format/minify/validate JSON, convert JSON to YAML, query with simplified JSONPath ($.a.b[0], $..key recursive descent). Highlights syntax inline.",
    Component: JsonTool,
  },
  {
    key: "urlparse",
    title: "URL parser",
    short: "URI",
    group: "parsing",
    description:
      "Break URL into protocol, origin, user, pass, host, port, path, fragment. Decodes query params into a table.",
    Component: UrlParserTool,
  },
  {
    key: "ua",
    title: "User-Agent",
    short: "UA",
    group: "parsing",
    description:
      "Extract browser, engine, OS, device, mobile/bot flags from a User-Agent header.",
    Component: UserAgentTool,
  },
  {
    key: "cron",
    title: "Cron",
    short: "CR",
    group: "parsing",
    description:
      "Parse 5-field cron expression (minute hour dom month dow). Shows next 5 fires and a short description.",
    Component: CronTool,
  },

  {
    key: "regex",
    title: "Regex",
    short: ".*",
    group: "text",
    description:
      "JS RegExp tester with flag toggles (gimsuy). Highlights matches, lists groups, supports replacement preview.",
    Component: RegexTool,
  },
  {
    key: "diff",
    title: "Diff",
    short: "Δ",
    group: "text",
    description:
      "Side-by-side text diff using LCS. Optional JSON normalization (formats both sides before comparing) so key order differences disappear.",
    Component: DiffTool,
  },
  {
    key: "gql",
    title: "GraphQL",
    short: "GQ",
    group: "text",
    description: "Format or minify GraphQL queries. Strips comments, normalizes indentation.",
    Component: GraphqlTool,
  },

  {
    key: "random",
    title: "Random",
    short: "RND",
    group: "generation",
    description:
      "Generate UUID v4 / v7 (sortable), random hex bytes, base64 bytes, or password (printable, no ambiguous chars).",
  },
  {
    key: "mock",
    title: "Mock data",
    short: "MK",
    group: "generation",
    description:
      "Batch generate fake names, emails, addresses, phones, UUIDs, lorem text, IPv4, or company names. Seed bodies for testing.",
    Component: MockDataTool,
  },
  {
    key: "curl",
    title: "cURL ↔ Knock",
    short: "cR",
    group: "generation",
    description:
      "Convert a cURL command into a Knock request TOML, or render a Knock TOML back as a cURL. Parses -X, -H, -d, --data-urlencode, -u, -A, -b, --user-agent, etc.",
    Component: CurlTool,
  },

  {
    key: "ip",
    title: "IP / CIDR",
    short: "IP",
    group: "network",
    description:
      "Parse IPv4 address or CIDR. Shows decimal, binary, hex, mask, wildcard, network, broadcast, first/last host, host count.",
    Component: IpTool,
  },

  {
    key: "date",
    title: "Date",
    short: "DT",
    group: "time",
    description:
      "Live current time in epoch (s/ms) and ISO. Parse arbitrary epoch or date string and view in local, UTC, ISO, and relative.",
  },

  {
    key: "numbase",
    title: "Number bases",
    short: "10",
    group: "conversion",
    description:
      "Convert between binary, octal, decimal, hexadecimal. Uses BigInt so handles arbitrary-size integers.",
    Component: NumberBaseTool,
  },
  {
    key: "unit",
    title: "Unit converter",
    short: "U",
    group: "conversion",
    description:
      "Byte sizes (decimal B/KB/MB/GB/TB and binary KiB/MiB/GiB/TiB) and time units (ns to weeks).",
    Component: UnitTool,
  },
  {
    key: "color",
    title: "Color",
    short: "🎨",
    group: "conversion",
    description:
      "Convert between hex, rgb(a), and hsl(a). Includes a swatch preview and native color picker.",
    Component: ColorTool,
  },
];

export const TOOL_MAP: Record<ToolKey, ToolDef> = (() => {
  const m: Record<string, ToolDef> = {};
  for (const t of TOOLS) m[t.key] = t;
  // dashboard not in TOOLS — synthetic
  m["dashboard"] = {
    key: "dashboard",
    title: "Tools dashboard",
    short: "≡",
    group: "encoding",
    description: "Browse all tools, organize favorites, mark which appear in the rail.",
  };
  return m as Record<ToolKey, ToolDef>;
})();

export const DEFAULT_FAVORITES: ToolKey[] = ["jwt", "base64", "json", "date", "random", "hash"];
