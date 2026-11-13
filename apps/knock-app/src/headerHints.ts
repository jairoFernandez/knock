export interface KeyHint {
  key: string;
  value: string;
  description: string;
}

export const HEADER_HINTS: KeyHint[] = [
  { key: "Authorization", value: "Bearer {{token}}", description: "Bearer token" },
  { key: "Authorization", value: "Basic {{basic_credentials}}", description: "Basic auth (base64 user:pass)" },
  { key: "Authorization", value: "Token {{token}}", description: "Token scheme" },
  { key: "Content-Type", value: "application/json", description: "JSON body" },
  { key: "Content-Type", value: "application/x-www-form-urlencoded", description: "Form body" },
  { key: "Content-Type", value: "multipart/form-data", description: "File upload" },
  { key: "Content-Type", value: "text/plain", description: "Plain text body" },
  { key: "Content-Type", value: "application/xml", description: "XML body" },
  { key: "Content-Type", value: "application/json; charset=utf-8", description: "JSON body, explicit charset" },
  { key: "Accept", value: "application/json", description: "Ask for JSON" },
  { key: "Accept", value: "*/*", description: "Accept anything" },
  { key: "Accept", value: "text/html", description: "Ask for HTML" },
  { key: "Accept", value: "application/xml", description: "Ask for XML" },
  { key: "Accept", value: "text/plain", description: "Ask for plain text" },
  { key: "Accept", value: "text/event-stream", description: "Server-sent events" },
  { key: "Accept-Language", value: "es-ES,es;q=0.9,en;q=0.8", description: "Preferred languages" },
  { key: "Accept-Encoding", value: "gzip, deflate, br", description: "Compressed responses" },
  { key: "X-API-Key", value: "{{api_key}}", description: "API key" },
  { key: "User-Agent", value: "knock", description: "Client identifier" },
  { key: "Cache-Control", value: "no-cache", description: "Skip caches" },
  { key: "Cache-Control", value: "no-store", description: "Never store" },
  { key: "Cache-Control", value: "max-age=0", description: "Revalidate" },
  { key: "If-None-Match", value: "\"etag\"", description: "Conditional GET by ETag" },
  { key: "If-Modified-Since", value: "Wed, 21 Oct 2015 07:28:00 GMT", description: "Conditional GET by date" },
  { key: "Idempotency-Key", value: "{{idempotency_key}}", description: "Safe retries for POST" },
  { key: "X-Request-ID", value: "{{request_id}}", description: "Trace a request" },
  { key: "Origin", value: "http://localhost:3000", description: "CORS origin" },
  { key: "Referer", value: "https://example.com/", description: "Referring page" },
  { key: "Cookie", value: "session={{session}}", description: "Send cookies" },
  { key: "X-Forwarded-For", value: "127.0.0.1", description: "Client IP behind proxy" },
  { key: "Connection", value: "close", description: "Close after response" },
  { key: "Connection", value: "keep-alive", description: "Reuse connection" },
  { key: "Range", value: "bytes=0-1023", description: "Partial content" },
];

export function hintFor(hints: KeyHint[], key: string): KeyHint | undefined {
  const k = key.trim().toLowerCase();
  if (!k) return undefined;
  return hints.find((h) => h.key.toLowerCase() === k);
}

export function valuesFor(hints: KeyHint[], key: string): KeyHint[] {
  const k = key.trim().toLowerCase();
  if (!k) return [];
  return hints.filter((h) => h.key.toLowerCase() === k);
}
