import * as vscode from 'vscode';
import axios from 'axios';
import { deployState } from './deploy_state';

/**
 * Stable JSON serialisation: sorts object keys and array elements so that
 * two semantically-identical payloads always produce the same string,
 * regardless of property/element ordering from the server.
 */
function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_key, val) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            return Object.keys(val).sort().reduce<Record<string, unknown>>((sorted, k) => {
                sorted[k] = val[k];
                return sorted;
            }, {});
        }
        if (Array.isArray(val)) {
            return [...val].sort((a, b) => {
                // Sort by 'id' or 'name' if available, otherwise by serialised form
                const keyA = a?.id ?? a?.name ?? JSON.stringify(a);
                const keyB = b?.id ?? b?.name ?? JSON.stringify(b);
                return String(keyA).localeCompare(String(keyB));
            });
        }
        return val;
    });
}

/** How long to wait without any data before assuming the connection is stale. */
const KEEPALIVE_TIMEOUT_MS = 90_000; // 90 seconds

export class GitOpsSSEClient {
    private stream: any = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private reconnectDelay = 1000;
    private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
    private url = '';
    private secret = '';

    /**
     * During reconnection we accumulate which providers need a refresh and
     * flush them once after a short settling window, so an initial state dump
     * from the server produces at most one refresh per provider.
     */
    private pendingRefresh = new Set<'automations' | 'images'>();
    private settleTimer: ReturnType<typeof setTimeout> | undefined;
    private static readonly SETTLE_MS = 600; // slightly longer than the tree-view debounce (500ms)

    constructor(
        private context: vscode.ExtensionContext,
        private businessProcessesProvider: { refresh(): void; refreshAutomations(): void },
        private imagesProvider: { refresh(): void },
        private orphanedImagesProvider: { refresh(): void },
    ) {}

    async connect(url: string, secret: string) {
        this.url = url;
        this.secret = secret;
        this.disconnect();

        try {
            const response = await axios.get(url + '/events/stream', {
                headers: { 'Authorization': `Bearer ${secret}` },
                responseType: 'stream',
                timeout: 0,
            });
            this.stream = response.data;
            this.reconnectDelay = 1000;
            this.resetKeepaliveTimer();

            let buffer = '';
            let currentEvent = '';

            this.stream.on('data', (chunk: Buffer) => {
                this.resetKeepaliveTimer();
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        currentEvent = line.slice(7).trim();
                    } else if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            this.handleEvent(currentEvent, data);
                        } catch {
                            // Ignore malformed JSON
                        }
                        currentEvent = '';
                    }
                    // Ignore comments (keepalive) and empty lines
                }
            });

            this.stream.on('end', () => this.scheduleReconnect());
            this.stream.on('error', () => this.scheduleReconnect());
        } catch {
            this.scheduleReconnect();
        }
    }

    private async handleEvent(event: string, data: any) {
        if (event === 'automations') {
            const current = this.context.globalState.get('automations', []);
            if (stableStringify(current) !== stableStringify(data)) {
                await this.context.globalState.update('automations', data);
                this.scheduleRefresh('automations');
            }
        } else if (event === 'images') {
            const current = this.context.globalState.get('images', []);
            if (stableStringify(current) !== stableStringify(data)) {
                await this.context.globalState.update('images', data);
                this.scheduleRefresh('images');
            }
        } else if (event === 'deploy_progress') {
            deployState.handleDeployProgress(data);
        }
    }

    /**
     * Batch refresh calls so that a burst of events (e.g. right after
     * reconnection) results in a single UI refresh per provider.
     */
    private scheduleRefresh(kind: 'automations' | 'images') {
        this.pendingRefresh.add(kind);
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
        }
        this.settleTimer = setTimeout(() => this.flushRefresh(), GitOpsSSEClient.SETTLE_MS);
    }

    private flushRefresh() {
        if (this.pendingRefresh.has('automations')) {
            this.businessProcessesProvider.refreshAutomations();
        }
        if (this.pendingRefresh.has('images')) {
            this.imagesProvider.refresh();
            this.orphanedImagesProvider.refresh();
        }
        this.pendingRefresh.clear();
    }

    private resetKeepaliveTimer() {
        if (this.keepaliveTimer) {
            clearTimeout(this.keepaliveTimer);
        }
        this.keepaliveTimer = setTimeout(() => {
            // No data received for a while — assume stale connection
            if (this.stream) {
                this.stream.destroy();
                this.stream = null;
            }
            this.scheduleReconnect();
        }, KEEPALIVE_TIMEOUT_MS);
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = setTimeout(() => this.connect(this.url, this.secret), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    }

    disconnect() {
        if (this.stream) {
            this.stream.destroy();
            this.stream = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.keepaliveTimer) {
            clearTimeout(this.keepaliveTimer);
            this.keepaliveTimer = undefined;
        }
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = undefined;
        }
        this.pendingRefresh.clear();
    }
}
