import * as vscode from 'vscode';
import axios from 'axios';
import { deployState } from './deploy_state';

export class GitOpsSSEClient {
    private stream: any = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private reconnectDelay = 1000;
    private url = '';
    private secret = '';

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

            let buffer = '';
            let currentEvent = '';

            this.stream.on('data', (chunk: Buffer) => {
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
            if (JSON.stringify(current) !== JSON.stringify(data)) {
                await this.context.globalState.update('automations', data);
                this.businessProcessesProvider.refreshAutomations();
            }
        } else if (event === 'images') {
            const current = this.context.globalState.get('images', []);
            if (JSON.stringify(current) !== JSON.stringify(data)) {
                await this.context.globalState.update('images', data);
                this.imagesProvider.refresh();
                this.orphanedImagesProvider.refresh();
            }
        } else if (event === 'deploy_progress') {
            deployState.handleDeployProgress(data);
        }
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
    }
}
