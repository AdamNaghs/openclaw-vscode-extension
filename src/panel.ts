import * as vscode from 'vscode';
import { OpenClawClient, OpenClawMessage, PendingTool } from './client';

export class OpenClawPanel {
    private panel: vscode.WebviewPanel | undefined;
    private client: OpenClawClient;
    private disposables: vscode.Disposable[] = [];
    private messageQueue: string[] = [];
    private pendingTools: Map<string, PendingTool> = new Map();

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
                    case 'approveTool':
                        await this.handleApproveTool(message.toolId, message.approved);
                        break;
                    case 'runCommand':
                        await this.handleRunCommand(message.command, message.cwd);
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

        // Check for @file mentions and include file content
        const fileMentionRegex = /@([\w./-]+)/g;
        let match;
        let enhancedText = text;
        
        while ((match = fileMentionRegex.exec(text)) !== null) {
            const filePath = match[1];
            const result = await this.client.readFile(filePath);
            if (result.success) {
                enhancedText += `\n\n[Content of ${filePath}]:\n\`\`\`\n${result.content}\n\`\`\``;
            }
        }

        const result = await this.client.sendMessage(enhancedText, { fileContext, filePath });

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

    private async handleApproveTool(toolId: string, approved: boolean) {
        const tool = this.pendingTools.get(toolId);
        if (!tool) return;

        this.pendingTools.delete(toolId);

        if (!approved) {
            tool.resolve({ error: 'User rejected tool execution' });
            this.panel?.webview.postMessage({ type: 'toolRejected', toolId });
            return;
        }

        let result: any;
        switch (tool.tool) {
            case 'read_file':
                result = await this.client.readFile(tool.args.file_path);
                break;
            case 'list_files':
                result = await this.client.listFiles(tool.args.dir_path);
                break;
            case 'run_command':
                result = await this.client.runCommand(tool.args.command, tool.args.cwd);
                break;
            case 'write_file':
                result = await this.client.writeFile(tool.args.file_path, tool.args.content);
                break;
            default:
                result = { error: `Unknown tool: ${tool.tool}` };
        }

        tool.resolve(result);
        this.panel?.webview.postMessage({ type: 'toolExecuted', toolId, result });
    }

    private async handleRunCommand(command: string, cwd?: string) {
        // Show VS Code native approval dialog
        const approval = await vscode.window.showWarningMessage(
            `Allow OpenClaw to run command?`,
            { modal: true, detail: `Command: ${command}\nDirectory: ${cwd || 'workspace root'}` },
            'Allow', 'Deny'
        );

        if (approval !== 'Allow') {
            this.panel?.webview.postMessage({ type: 'commandResult', command, error: 'User denied execution' });
            return;
        }

        const result = await this.client.runCommand(command, cwd);
        this.panel?.webview.postMessage({ type: 'commandResult', command, ...result });
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
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenClaw</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; line-height: 1.5; height: 100vh; display: flex; flex-direction: column; }
        .header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-errorForeground); }
        .status-dot.connected { background: var(--vscode-testing-iconPassed); }
        .status-text { font-size: 12px; color: var(--vscode-descriptionForeground); }
        .toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-shrink: 0; }
        .toolbar button { padding: 4px 12px; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .messages { flex: 1; overflow-y: auto; margin-bottom: 16px; min-height: 0; }
        .message { margin-bottom: 16px; padding: 12px; border-radius: 6px; }
        .message.user { background: var(--vscode-editor-inactiveSelectionBackground); }
        .message.assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
        .message-header { font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
        .message-content { white-space: pre-wrap; word-break: break-word; }
        .message-content pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
        .message-content code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
        .input-area { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
        textarea { flex: 1; min-height: 60px; max-height: 200px; padding: 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-family: inherit; font-size: inherit; resize: vertical; }
        textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
        button { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .error-banner { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-errorForeground); padding: 10px 12px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; flex-shrink: 0; }
        .apply-button { margin-top: 8px; padding: 4px 12px; font-size: 12px; margin-right: 8px; }
        .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    </style>
</head>
<body>
    <div class="header">
        <div id="statusDot" class="status-dot"></div>
        <span class="status-text" id="statusText">Not connected</span>
    </div>
    <div class="toolbar">
        <button id="fileBtn">+ File</button>
    </div>
    <div id="errorBanner" class="error-banner" style="display: none;"></div>
    <div id="messages" class="messages"></div>
    <div class="input-area">
        <textarea id="messageInput" placeholder="Ask OpenClaw... Use @filename to include files (Shift+Enter for new line, Enter to send)"></textarea>
        <button id="sendBtn">Send</button>
    </div>
    <p class="hint">Tip: Type @filename to include file contents in your message</p>
    <script>
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isConnected = false;

        function updateStatus(connected, text) {
            isConnected = connected;
            document.getElementById("statusDot").classList.toggle("connected", connected);
            document.getElementById("statusText").textContent = text || (connected ? "Connected" : "Not connected");
        }

        function showError(message) {
            const banner = document.getElementById("errorBanner");
            if (message) { banner.textContent = message; banner.style.display = "block"; }
            else { banner.style.display = "none"; }
        }

        function insertFileRef() {
            const input = document.getElementById("messageInput");
            input.value += " @";
            input.focus();
        }

        function renderMessages() {
            const container = document.getElementById("messages");
            container.innerHTML = messages.map((msg, idx) => {
                const role = msg.role === "assistant" ? "assistant" : "user";
                const name = msg.role === "assistant" ? "OpenClaw" : "You";
                const content = formatContent(msg.content);
                let html = '<div class="message ' + role + '">' +
                    '<div class="message-header">' + name + '</div>' +
                    '<div class="message-content">' + content + '</div>';
                if (msg.role === "assistant") {
                    html += renderActions(msg.content, idx);
                }
                html += '</div>';
                return html;
            }).join('');
            container.scrollTop = container.scrollHeight;
        }

        function formatContent(text) {
            return text
                .replace(/\`\`\`(\w+)?\n([\s\S]*?)\n\`\`\`/g, "<pre><code>$2</code></pre>")
                .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
                .replace(/\n/g, "<br>");
        }

        function renderActions(content, idx) {
            let actions = "";
            if (content.includes("\`\`\`")) {
                actions += '<button class="apply-button" onclick="applyEdit(' + idx + ')">Apply Edit</button>';
            }
            return actions;
        }

        function getCodeBlock(msgIdx) {
            const msg = messages[msgIdx];
            if (!msg || msg.role !== "assistant") return null;
            const match = msg.content.match(/\`\`\`[\s\S]*?\n([\s\S]*?)\n\`\`\`/);
            return match ? match[1] : null;
        }

        function applyEdit(idx) {
            const code = getCodeBlock(idx);
            if (code) {
                vscode.postMessage({ command: "applyEdit", edit: { newText: code } });
            }
        }

        function sendMessage() {
            const input = document.getElementById("messageInput");
            const text = input.value.trim();
            if (!text || !isConnected) return;
            messages.push({ role: "user", content: text });
            renderMessages();
            vscode.postMessage({ command: "send", text });
            input.value = "";
        }

        document.getElementById("messageInput").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });

        document.getElementById("sendBtn").addEventListener("click", sendMessage);
        document.getElementById("fileBtn").addEventListener("click", insertFileRef);

        window.addEventListener("message", (e) => {
            const msg = e.data;
            switch (msg.type) {
                case "status":
                    updateStatus(msg.success, msg.success ? "Connected to OpenClaw" : msg.error);
                    showError(msg.success ? "" : msg.error);
                    break;
                case "history":
                    const newMsgs = msg.messages.filter(m => !messages.some(ex => ex.content === m.content && ex.role === m.role));
                    if (newMsgs.length > 0) { messages = [...messages, ...newMsgs]; renderMessages(); }
                    break;
                case "error": showError(msg.message); break;
                case "queuedQuery": document.getElementById("messageInput").value = msg.text; sendMessage(); break;
            }
        });

        vscode.postMessage({ command: "checkConnection" });
    </script>
</body>
</html>`;
    }

    dispose() {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
