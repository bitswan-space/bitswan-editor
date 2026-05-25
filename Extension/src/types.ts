export type JupyterServerRequestResponse = {
  status: string;
  message: string;
  server_info: {
    pre: string;
    port: number;
    token: string;
    url: string;
  };
};

export type BitswanJupyterServer = {
  pre: string;
  port: number;
  token: string;
  url: string;
  automationName: string;
  sessionId: string;
  automationDirectoryPath: string;
};

export type BitswanJupyterServerRecords = Record<string, BitswanJupyterServer>;

export interface Snapshot {
    snapshot_id: string;
    name: string | null;
    source_stage: string;
    workspace: string;
    created_at: string;
    sizes_bytes: { postgres: number; couchdb: number; minio: number; total: number };
    gitops_version: string;
    known_limitations: string[];
}

export interface SnapshotTask {
    task_id: string;
    kind: 'create' | 'clone' | 'delete';
    snapshot_id: string;
    source_stage: string;
    target_stage: string | null;
    status: 'pending' | 'running' | 'success' | 'error';
    step: string | null;
    message: string;
    error: string | null;
    per_service_errors: Record<string, string | null>;
    started_at: string;
    updated_at: string;
    bytes_done: number;
    bytes_total: number;
}
