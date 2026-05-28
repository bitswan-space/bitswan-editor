import axios from 'axios';
import urlJoin from 'proper-url-join';

interface GitopsResult<T = unknown> {
    ok: boolean;
    status: number;
    body: T | null;
}

/**
 * Thin client for the bitswan-gitops REST API. Mirrors the dashboard's
 * server-side GitopsClient (without the SSE state machine — `sse_client.ts`
 * owns the long-lived `/events/stream` subscription).
 */
export class GitopsClient {
    private readonly baseUrl: string;
    private readonly secret: string;

    constructor(baseUrl: string, secret: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.secret = secret;
    }

    private async request<T>(
        path: string,
        init: { method?: string; body?: unknown; query?: Record<string, string | number> } = {},
    ): Promise<GitopsResult<T>> {
        const url = urlJoin(this.baseUrl, path, init.query ? { query: init.query } : {}).toString();
        try {
            const r = await axios.request<T>({
                method: init.method ?? 'GET',
                url,
                headers: {
                    Authorization: `Bearer ${this.secret}`,
                    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                data: init.body !== undefined ? JSON.stringify(init.body) : undefined,
                validateStatus: () => true,
            });
            return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.data ?? null };
        } catch (err: any) {
            // Network / transport error — surface as 0 status so callers can branch.
            return { ok: false, status: 0, body: null };
        }
    }

    /**
     * `POST /automations/start-deploy` — bind-mounted dev/live-dev deploy.
     * Gitops resolves the source under its workspace bind mount, merges
     * `bitswan_lib` if present, computes a checksum, and runs the deploy
     * asynchronously. Returns `{ task_id, deployment_id, checksum, url, status }`.
     */
    async startDeploy(input: {
        relative_path: string;
        stage: 'dev' | 'live-dev';
        worktree?: string;
    }): Promise<GitopsResult> {
        return this.request('automations/start-deploy', { method: 'POST', body: input });
    }

    /**
     * `POST /processes/` — create a new business-process directory. Scaffolds
     * `process.toml` + `README.md` in the main repo or the named worktree.
     * Gitops broadcasts the updated `processes` SSE event inline.
     */
    async createProcess(input: { name: string; worktree?: string }): Promise<GitopsResult> {
        return this.request('processes/', { method: 'POST', body: input });
    }

    /**
     * `GET /templates/` — list available templates and template groups,
     * merged from the built-in `/workspace/examples` and the workspace's
     * `templates/` overlay.
     */
    async getTemplates(): Promise<GitopsResult<{ templates: unknown[]; groups: unknown[] }>> {
        return this.request('templates/');
    }

    /**
     * `POST /automations/from-template` — scaffold a new automation (single
     * template) or a group of automations (template group) under the given
     * BP. Gitops handles the copy, automation.toml UUID injection, and git
     * commit.
     */
    async createAutomationFromTemplate(input: {
        template_id?: string;
        group_id?: string;
        name?: string;
        bp: string;
        worktree?: string;
    }): Promise<GitopsResult> {
        return this.request('automations/from-template', { method: 'POST', body: input });
    }
}
