import * as vscode from 'vscode';
import { OpenClawClient, OpenClawMessage, PendingTool } from './client';

export class OpenClawPanel {
    private panel: vscode.WebviewPanel | undefined;
    private client: OpenClawClient;
    private disposables: vscode.Disposable[] = [];
    private messageQueue: string[] = [];
    private pendingTools: Map<string, PendingTool> = new Map();
    private pollingTimer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        client: OpenClawClient
    ) {
        this.client = client;
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
            this.stopPolling();
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

        // Start polling AFTER panel is created, and check connection first
        this.checkConnection().then(() => {
            this.startPolling();
            this.flushQueue();
        });
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
            const mentioned = match[1];
            const result = await this.client.readFile(mentioned);
            if (result.success) {
                enhancedText += `\n\n[Content of ${mentioned}]:\n\`\`\`\n${result.content}\n\`\`\``;
            }
        }

        // Show sending state
        this.panel?.webview.postMessage({ type: 'sending', active: true });

        const result = await this.client.sendMessage(enhancedText, { fileContext, filePath });

        this.panel?.webview.postMessage({ type: 'sending', active: false });

        if (!result.success) {
            this.panel?.webview.postMessage({
                type: 'error',
                message: result.error || 'Failed to send'
            });
        }
    }

    private async handleApplyEdit(edit: { oldText: string; newText: string }) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

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
        if (!tool) { return; }

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
        this.stopPolling();
        this.pollingTimer = setInterval(async () => {
            if (!this.panel) { return; }
            try {
                const history = await this.client.fetchHistory();
                if (history.length > 0) {
                    this.panel?.webview.postMessage({ type: 'history', messages: history });
                }
            } catch {
                // Swallow polling errors
            }
        }, 3000);
    }

    private stopPolling() {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
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
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 16px;
            line-height: 1.5;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            display: flex; align-items: center; gap: 8px;
            margin-bottom: 16px; padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .status-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: var(--vscode-errorForeground);
        }
        .status-dot.connected { background: var(--vscode-testing-iconPassed); }
        .status-text { font-size: 12px; color: var(--vscode-descriptionForeground); }
        .toolbar { display: flex; gap: 8px; margin-bottom: 12px; flex-shrink: 0; }
        .toolbar button {
            padding: 4px 12px; font-size: 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none; border-radius: 4px; cursor: pointer;
        }
        .messages { flex: 1; overflow-y: auto; margin-bottom: 16px; min-height: 0; }
        .message { margin-bottom: 16px; padding: 12px; border-radius: 6px; }
        .message.user { background: var(--vscode-editor-inactiveSelectionBackground); }
        .message.assistant {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
        }
        .message-header {
            font-size: 11px; font-weight: 600; text-transform: uppercase;
            margin-bottom: 8px; color: var(--vscode-descriptionForeground);
        }
        .message-content { white-space: pre-wrap; word-break: break-word; }
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0;
        }
        .message-content code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        .input-area {
            display: flex; gap: 8px; padding-top: 12px;
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        textarea {
            flex: 1; min-height: 60px; max-height: 200px; padding: 10px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px; font-family: inherit; font-size: inherit; resize: vertical;
        }
        textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
        button {
            padding: 8px 16px; background: var(--vscode-button-background);
            color: var(--vscode-button-foreground); border: none;
            border-radius: 4px; cursor: pointer; font-size: 13px;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .error-banner {
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-errorForeground);
            padding: 10px 12px; border-radius: 4px; margin-bottom: 16px;
            font-size: 13px; flex-shrink: 0;
        }
        .apply-button {
            margin-top: 8px; padding: 4px 12px; font-size: 12px; margin-right: 8px;
        }
        .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
        .sending-indicator {
            font-size: 12px; color: var(--vscode-descriptionForeground);
            padding: 4px 0; display: none;
        }
        .sending-indicator.active { display: block; }
    </style>
</head>
<body>
    <div class="header">
        <div id="statusDot" class="status-dot"></div>
        <span class="status-text" id="statusText">Connecting...</span>
    </div>
    <div class="toolbar">
        <button id="fileBtn">+ File</button>
        <button id="reconnectBtn">Reconnect</button>
    </div>
    <div id="errorBanner" class="error-banner" style="display: none;"></div>
    <div id="messages" class="messages"></div>
    <div id="sendingIndicator" class="sending-indicator">Sending...</div>
    <div class="input-area">
        <textarea id="messageInput" placeholder="Ask OpenClaw... (Shift+Enter for new line, Enter to send)"></textarea>
        <button id="sendBtn">Send</button>
    </div>
    <p class="hint">Tip: Type @filename to include file contents in your message</p>
    <script>
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isConnected = false;

        function escapeHtml(str) {
            return str
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
        }

        function updateStatus(connected, text) {
            isConnected = connected;
            document.getElementById("statusDot").classList.toggle("connected", connected);
            document.getElementById("statusText").textContent = text || (connected ? "Connected" : "Not connected");
            document.getElementById("sendBtn").disabled = !connected;
        }

        function showError(message) {
            var banner = document.getElementById("errorBanner");
            if (message) { banner.textContent = message; banner.style.display = "block"; }
            else { banner.style.display = "none"; }
        }

        function insertFileRef() {
            var input = document.getElementById("messageInput");
            input.value += " @";
            input.focus();
        }

        function renderMessages() {
            var container = document.getElementById("messages");
            container.innerHTML = messages.map(function(msg, idx) {
                var role = msg.role === "assistant" ? "assistant" : "user";
                var name = msg.role === "assistant" ? "OpenClaw" : "You";
                var content = formatContent(msg.content || "");
                var hasCode = (msg.content || "").indexOf("\`\`\`") !== -1;
                var actionsHtml = "";
                if (msg.role === "assistant" && hasCode) {
                    actionsHtml = '<button class="apply-button" data-msg-idx="' + idx + '">Apply Edit</button>';
                }
                return '<div class="message ' + role + '">' +
                    '<div class="message-header">' + escapeHtml(name) + '</div>' +
                    '<div class="message-content">' + content + '</div>' +
                    actionsHtml +
                    '</div>';
            }).join("");

            // Bind apply-edit buttons (no inline onclick — CSP safe)
            container.querySelectorAll(".apply-button").forEach(function(btn) {
                btn.addEventListener("click", function() {
                    var idx = parseInt(btn.getAttribute("data-msg-idx"), 10);
                    applyEdit(idx);
                });
            });

            container.scrollTop = container.scrollHeight;
        }

        function formatContent(text) {
            if (typeof text !== "string") { text = String(text || ""); }
            var escaped = escapeHtml(text);
            var bt = String.fromCharCode(96);
            // Replace fenced code blocks (triple backtick)
            var triple = bt + bt + bt;
            while (true) {
                var start = escaped.indexOf(triple);
                if (start === -1) break;
                var end = escaped.indexOf(triple, start + 3);
                if (end === -1) break;
                var code = escaped.substring(start + 3, end);
                // Remove language tag if present
                var newlineIdx = code.indexOf("\\n");
                if (newlineIdx !== -1 && newlineIdx < 20) {
                    code = code.substring(newlineIdx + 2);
                }
                escaped = escaped.substring(0, start) + "<pre><code>" + code + "</code></pre>" + escaped.substring(end + 3);
            }
            // Replace inline code (single backtick)
            while (true) {
                var start = escaped.indexOf(bt);
                if (start === -1) break;
                var end = escaped.indexOf(bt, start + 1);
                if (end === -1) break;
                var code = escaped.substring(start + 1, end);
                escaped = escaped.substring(0, start) + "<code>" + code + "</code>" + escaped.substring(end + 1);
            }
            return escaped.replace(/\n/g, "<br>");
        }

        function getCodeBlock(msgIdx) {
            var msg = messages[msgIdx];
            if (!msg || msg.role !== "assistant") return null;
            var content = msg.content || "";
            var triple = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
            var start = content.indexOf(triple);
            if (start === -1) return null;
            var end = content.indexOf(triple, start + 3);
            if (end === -1) return null;
            var code = content.substring(start + 3, end).trim();
            // Remove language tag if present on first line
            var newlineIdx = code.indexOf("\n");
            if (newlineIdx !== -1) {
                code = code.substring(newlineIdx + 1);
            }
            return code;
        }

        function applyEdit(idx) {
            var code = getCodeBlock(idx);
            if (code) {
                vscode.postMessage({ command: "applyEdit", edit: { newText: code } });
            }
        }

        function sendMessage() {
            var input = document.getElementById("messageInput");
            var text = input.value.trim();
            if (!text || !isConnected) return;
            messages.push({ role: "user", content: text, timestamp: new Date().toISOString() });
            renderMessages();
            vscode.postMessage({ command: "send", text: text });
            input.value = "";
        }

        // Event listeners (CSP-safe, no inline handlers)
        document.getElementById("messageInput").addEventListener("keydown", function(e) {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        document.getElementById("sendBtn").addEventListener("click", sendMessage);
        document.getElementById("fileBtn").addEventListener("click", insertFileRef);
        document.getElementById("reconnectBtn").addEventListener("click", function() {
            updateStatus(false, "Reconnecting...");
            showError("");
            vscode.postMessage({ command: "checkConnection" });
        });

        window.addEventListener("message", function(e) {
            var msg = e.data;
            switch (msg.type) {
                case "status":
                    updateStatus(msg.success, msg.success ? "Connected to OpenClaw" : msg.error);
                    showError(msg.success ? "" : msg.error);
                    break;
                case "history":
                    if (msg.messages && msg.messages.length > 0) {
                        // Replace all messages with the latest history snapshot
                        // Preserve any locally-added user messages not yet in history
                        var serverMsgs = msg.messages;
                        messages = serverMsgs;
                        renderMessages();
                    }
                    break;
                case "error":
                    showError(msg.message);
                    break;
                case "sending":
                    var indicator = document.getElementById("sendingIndicator");
                    indicator.classList.toggle("active", !!msg.active);
                    break;
                case "queuedQuery":
                    document.getElementById("messageInput").value = msg.text;
                    sendMessage();
                    break;
            }
        });

        // Request initial connection check
        vscode.postMessage({ command: "checkConnection" });
    </script>
</body>
</html>`;
    }

    dispose() {
        this.stopPolling();
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
