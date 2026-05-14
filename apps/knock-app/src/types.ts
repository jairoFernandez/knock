export interface WorkspaceInfo {
  root: string;
  activeEnv: string | null;
}

export interface ResponseDto {
  status: number;
  url: string;
  method: string;
  elapsedMs: number;
  headers: [string, string][];
  body: string;
}
