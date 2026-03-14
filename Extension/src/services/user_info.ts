import * as vscode from 'vscode';

let cachedUserEmail: string | undefined;
let fetchPromise: Promise<string | undefined> | undefined;

/**
 * Get the authenticated user's email.
 * Fetches it from the OAuth2 proxy via a hidden webview on first call, then caches.
 */
export async function getUserEmail(context: vscode.ExtensionContext): Promise<string | undefined> {
    if (cachedUserEmail) {
        return cachedUserEmail;
    }
    if (!fetchPromise) {
        fetchPromise = fetchEmailFromWebview(context).then((email) => {
            if (email) {
                cachedUserEmail = email;
            }
            return cachedUserEmail;
        }).catch(() => undefined);
    }
    return fetchPromise;
}

/**
 * Initialize user info eagerly at extension activation.
 * Fires and forgets — the result is cached for later use.
 */
export function initUserInfo(context: vscode.ExtensionContext): void {
    getUserEmail(context);
}

function fetchEmailFromWebview(context: vscode.ExtensionContext): Promise<string | undefined> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'bitswan-userinfo',
            'Loading...',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
            { enableScripts: true },
        );

        // Hide the panel as much as possible
        panel.reveal(vscode.ViewColumn.Active, true);

        const timeout = setTimeout(() => {
            panel.dispose();
            resolve(undefined);
        }, 5000);

        panel.webview.onDidReceiveMessage(
            (message) => {
                clearTimeout(timeout);
                panel.dispose();
                if (message.type === 'userinfo' && message.email) {
                    resolve(message.email);
                } else {
                    resolve(undefined);
                }
            },
            undefined,
            context.subscriptions,
        );

        panel.webview.html = `<!DOCTYPE html>
<html><body><script>
(async () => {
    const vscode = acquireVsCodeApi();
    try {
        const res = await fetch('/oauth2/userinfo');
        if (res.ok) {
            const data = await res.json();
            vscode.postMessage({ type: 'userinfo', email: data.email || data.preferredUsername });
        } else {
            vscode.postMessage({ type: 'userinfo', email: null });
        }
    } catch (e) {
        vscode.postMessage({ type: 'userinfo', email: null });
    }
})();
</script></body></html>`;
    });
}
