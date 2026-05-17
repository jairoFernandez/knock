export interface WorkspaceInfo {
  root: string;
  name: string | null;
  activeEnv: string | null;
  color?: string | null;
  icon?: string | null;
}

export type EntryKind =
  | "request"
  | "fragment"
  | "environment"
  | "flow"
  | "config"
  | "openapi"
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
  | { kind: "form"; form: KV[] }
  | { kind: "file"; path: string };

export interface OpenApiResponseInfo {
  description?: string | null;
  contentType?: string | null;
  example?: string | null;
}

export interface OpenApiMark {
  operationId: string;
  path: string;
  specVersion: string;
  generatedHash: string;
  responses?: Record<string, OpenApiResponseInfo>;
}

export interface RequestForm {
  name: string | null;
  method: string;
  url: string;
  uses: string[];
  headers: KV[];
  query: KV[];
  path?: KV[];
  body: BodyForm;
  openapi?: OpenApiMark | null;
}

export interface OpenApiMeta {
  hasSpec: boolean;
  specRel: string | null;
  specFormat: string | null;
  specVersion: string | null;
  lastImportedAt: number | null;
  sourceUrl: string | null;
  operationCount: number;
}

export type OpenApiOpStatus = "new" | "modified" | "unchanged" | "removed";

export interface OpenApiOperationPreview {
  operationId: string;
  method: string;
  path: string;
  tag: string | null;
  summary: string | null;
  targetRel: string;
  status: OpenApiOpStatus;
  existingWasManuallyEdited: boolean;
}

export interface OpenApiPreview {
  specVersion: string;
  specFormat: string;
  title: string | null;
  sourceUrl: string | null;
  operations: OpenApiOperationPreview[];
  specText: string;
  specExt: string;
}

export interface OpenApiSource {
  kind: "url" | "file";
  value: string;
}

export interface OpenApiHistoryEntry {
  rel: string;
  name: string;
}

export interface RecentEntry {
  root: string;
  name: string | null;
  lastOpened: number;
  color?: string | null;
  icon?: string | null;
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
  upstream?: string | null;
  ahead: number;
  behind: number;
  lastCommitSubject?: string | null;
  lastCommitAt?: number | null;
  lastCommitShort?: string | null;
}




