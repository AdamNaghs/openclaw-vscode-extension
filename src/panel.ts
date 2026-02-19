import * as vscode from 'vscode';
import { OpenClawClient, OpenClawMessage } from './client';

export class OpenClawPanel {
    private panel: vscode.WebviewPanel | undefined;
    private client: OpenClawClient;
    private disposables: vscode.Disposable[] = [];
    private messageQueue: string[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        client: OpenClawClient
    ) {
        this.client = client;
        this.startPolling();
    }

    show() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Two);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'openclaw',
            'OpenClaw',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri]
            }
        );

        this.panel.webview.html = this.getHtml();

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
        });

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'send':
                        await this.handleSend(message.text);
                        break;
                    case 'applyEdit':
                        await this.handleApplyEdit(message.edit);
                        break;
                    case 'checkConnection':
                        await this.checkConnection();
                        break;
                }
            },
            undefined,
            this.disposables
        );

        this.checkConnection();
    }

    reveal() {
        this.panel?.reveal(vscode.ViewColumn.Two);
    }

    sendQuery(query: string) {
        this.messageQueue.push(query);
        if (this.panel) {
            this.flushQueue();
        }
    }

    private async flushQueue() {
        while (this.messageQueue.length > 0) {
            const query = this.messageQueue.shift();
            if (query) {
                this.panel?.webview.postMessage({
                    type: 'queuedQuery',
                    text: query
                });
            }
        }
    }

    private async handleSend(text: string) {
        const editor = vscode.window.activeTextEditor;
        const fileContext = editor ? editor.document.getText() : undefined;
        const filePath = editor ? editor.document.fileName : undefined;

        const result = await this.client.sendMessage(text, { fileContext, filePath });

        if (!result.success) {
            this.panel?.webview.postMessage({
                type: 'error',
                message: result.error || 'Failed to send'
            });
        }
    }

    private async handleApplyEdit(edit: { oldText: string; newText: string }) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const fullText = document.getText();
        
        const startIdx = fullText.indexOf(edit.oldText);
        if (startIdx === -1) {
            vscode.window.showErrorMessage('Could not find code to replace');
            return;
        }

        const startPos = document.positionAt(startIdx);
        const endPos = document.positionAt(startIdx + edit.oldText.length);
        const range = new vscode.Range(startPos, endPos);

        await editor.edit(builder => builder.replace(range, edit.newText));
        vscode.window.showInformationMessage('Edit applied');
    }

    private async checkConnection() {
        const status = await this.client.testConnection();
        this.panel?.webview.postMessage({ type: 'status', ...status });
    }

    private startPolling() {
        const interval = setInterval(async () => {
            if (!this.panel) return;
            const history = await this.client.fetchHistory();
            this.panel.webview.postMessage({ type: 'history', messages: history.slice(-10) });
        }, 2000);
        this.disposables.push({ dispose: () => clearInterval(interval) });
    }

    private getHtml(): string {
        return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '    <meta charset="UTF-8">',
            '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '    <title>OpenClaw</title>',
            '    <style>',
            '        * { box-sizing: border-box; margin: 0; padding: 0; }',
            '        body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; line-height: 1.5; }',
            '        .header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }',
            '        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-errorForeground); }',
            '        .status-dot.connected { background: var(--vscode-testing-iconPassed); }',
            '        .status-text { font-size: 12px; color: var(--vscode-descriptionForeground); }',
            '        .messages { flex: 1; overflow-y: auto; max-height: calc(100vh - 200px); margin-bottom: 16px; }',
            '        .message { margin-bottom: 16px; padding: 12px; border-radius: 6px; }',
            '        .message.user { background: var(--vscode-editor-inactiveSelectionBackground); }',
            '        .message.assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }',
            '        .message-header { font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }',
            '        .message-content { white-space: pre-wrap; word-break: break-word; }',
            '        .message-content pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }',
            '        .message-content code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }',
            '        .input-area { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border); }',
            '        textarea { flex: 1; min-height: 60px; max-height: 200px; padding: 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-family: inherit; font-size: inherit; resize: vertical; }',
            '        textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }',
            '        button { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }',
            '        button:hover { background: var(--vscode-button-hoverBackground); }',
            '        button:disabled { opacity: 0.5; cursor: not-allowed; }',
            '        .error-banner { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-errorForeground); padding: 10px 12px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }',
            '        .apply-button { margin-top: 8px; padding: 4px 12px; font-size: 12px; }',
            '    </style>',
            '</head>',
            '<body>',
            '    <div class="header">',
            '        <div id="statusDot" class="status-dot"></div>',
            '        <span class="status-text" id="statusText">Not connected</span>',
            '    </div>',
            '    <div id="errorBanner" class="error-banner" style="display: none;"></div>',
            '    <div id="messages" class="messages"></div>',
            '    <div class="input-area">',
            '        <textarea id="messageInput" placeholder="Ask OpenClaw... (Shift+Enter for new line, Enter to send)"></textarea>',
            '        <button id="sendBtn" onclick="sendMessage()">Send</button>',
            '    </div>',
            '    <script>',
            '        const vscode = acquireVsCodeApi();',
            '        let messages = [];',
            '        let isConnected = false;',
            '        function updateStatus(connected, text) {',
            '            isConnected = connected;',
            '            document.getElementById("statusDot").classList.toggle("connected", connected);',
            '            document.getElementById("statusText").textContent = text || (connected ? "Connected" : "Not connected");',
            '        }',
            '        function showError(message) {',
            '            const banner = document.getElementById("errorBanner");',
            '            if (message) { banner.textContent = message; banner.style.display = "block"; }',
            '            else { banner.style.display = "none"; }',
            '        }',
            '        function renderMessages() {',
            '            const container = document.getElementById("messages");',
            '            container.innerHTML = messages.map(msg => {',
            '                const role = msg.role === "assistant" ? "assistant" : "user";',
            '                const name = msg.role === "assistant" ? "OpenClaw" : "You";',
            '                const content = formatContent(msg.content);',
            '                return \'<div class="message \' + role + \'">\' +',
            '                    \'<div class="message-header">\' + name + \'</div>\' +',
            '                    \'<div class="message-content">\' + content + \'</div>\' +',
            '                    (msg.role === "assistant" ? renderApplyButton(msg.content) : "") +',
            '                    \'</div>\';',
            '            }).join("");',
            '            container.scrollTop = container.scrollHeight;',
            '        }',
            '        function formatContent(text) {',
            '            return text',
            '                .replace(/```(\\w+)?\\n([\\s\\S]*?)\\n```/g, "<pre><code>$2</code></pre>")',
            '                .replace(/`([^`]+)`/g, "<code>$1</code>")',
            '                .replace(/\\n/g, "<br>");',
            '        }',
            '        function renderApplyButton(content) {',
            '            if (content.includes("```")) {',
            '                return \'<button class="apply-button" onclick="applyLastEdit()">Apply Edit</button>\';',
            '            }',
            '            return "";',
            '        }',
            '        function sendMessage() {',
            '            const input = document.getElementById("messageInput");',
            '            const text = input.value.trim();',
            '            if (!text || !isConnected) return;',
            '            messages.push({ role: "user", content: text });',
            '            renderMessages();',
            '            vscode.postMessage({ command: "send", text });',
            '            input.value = "";',
            '        }',
            '        function applyLastEdit() {',
            '            const lastMsg = messages.filter(m => m.role === "assistant").pop();',
            '            if (!lastMsg) return;',
            '            const match = lastMsg.content.match(/```[\\s\\S]*?\\n([\\s\\S]*?)\\n```/);',
            '            if (match) {',
            '                vscode.postMessage({ command: "applyEdit", edit: { newText: match[1] } });',
            '            }',
            '        }',
            '        document.getElementById("messageInput").addEventListener("keydown", (e) => {',
            '            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }',
            '        });',
            '        window.addEventListener("message", (e) => {',
            '            const msg = e.data;',
            '            switch (msg.type) {',
            '                case "status":',
            '                    updateStatus(msg.success, msg.success ? "Connected to OpenClaw" : msg.error);',
            '                    showError(msg.success ? "" : msg.error);',
            '                    break;',
            '                case "history":',
            '                    const newMsgs = msg.messages.filter(m => !messages.some(ex => ex.content === m.content && ex.role === m.role));',
            '                    if (newMsgs.length > 0) { messages = [...messages, ...newMsgs]; renderMessages(); }',
            '                    break;',
            '                case "error": showError(msg.message); break;',
            '                case "queuedQuery": document.getElementById("messageInput").value = msg.text; sendMessage(); break;',
            '            }',
            '        });',
            '        vscode.postMessage({ command: "checkConnection" });',
            '    </script>',
            '</body>',
            '</html>'
        ].join('\n');
    }

    dispose() {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
