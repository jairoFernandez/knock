const METHOD_RE = /^\s*method\s*=\s*"([^"]*)"/m;
const URL_RE = /^\s*url\s*=\s*"([^"]*)"/m;
const NAME_RE = /^\s*name\s*=\s*"([^"]*)"/m;

export interface RequestPeek {
  method: string;
  url: string;
  name: string | null;
}

export function peekRequest(toml: string): RequestPeek {
  const method = METHOD_RE.exec(toml)?.[1] ?? "";
  const url = URL_RE.exec(toml)?.[1] ?? "";
  const name = NAME_RE.exec(toml)?.[1] ?? null;
  return { method, url, name };
}
