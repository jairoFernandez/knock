export interface WorkspaceInfo {
  root: string;
  activeEnv: string | null;
}

export type EntryKind =
  | "request"
  | "fragment"
  | "environment"
  | "flow"
  | "config"
  | "other";

export interface TreeEntry {
  rel: string;
  kind: EntryKind;
  method: string | null;
  name: string | null;
}

export interface ResponseDto {
  status: number;
  url: string;
  method: string;
  elapsedMs: number;
  headers: [string, string][];
  body: string;
}
