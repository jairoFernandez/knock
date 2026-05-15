export interface WorkspaceInfo {
  root: string;
  name: string | null;
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

export interface DirEntryDto {
  rel: string;
}

export interface ResponseDto {
  status: number;
  url: string;
  method: string;
  elapsedMs: number;
  headers: [string, string][];
  bodyBase64: string;
}

export interface KV {
  key: string;
  value: string;
}

export type BodyForm =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "json"; json: string }
  | { kind: "file"; path: string };

export interface RequestForm {
  name: string | null;
  method: string;
  url: string;
  uses: string[];
  headers: KV[];
  query: KV[];
  body: BodyForm;
}

export interface RecentEntry {
  root: string;
  name: string | null;
  lastOpened: number;
}

export interface FileEntry {
  rel: string;
  size: number;
  isText: boolean;
}

export interface CommitDto {
  hash: string;
  short: string;
  author: string;
  date: number;
  subject: string;
}

export interface FileChangeDto {
  status: string;
  path: string;
}

export interface WorkingChangeDto {
  path: string;
  staged: string;
  unstaged: string;
}

export interface GitStateDto {
  branch: string;
  hasCommits: boolean;
  changes: WorkingChangeDto[];
  stagedCount: number;
  unstagedCount: number;
}




