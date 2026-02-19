import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec as execCb } from 'child_process';

export interface OpenClawMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: string;
}

export interface PendingTool {
    id: string;
    tool: string;
    args: any;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
}

export class OpenClawClient {
    private baseUrl: string = '';
    private token: string = '';
    private sessionKey: string = 'agent:main:main';
    private connected: boolean = false;
    private messageHandlers: ((msg: OpenClawMessage) => void)[] = [];
    private toolRequestHandlers: ((tool: PendingTool) => void)[] = [];

    constructor() {
        this.loadConfig();
        
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('openclaw')) {
                this.loadConfig();
            }
        });
    }

    private loadConfig() {
        const config = vscode.workspace.getConfiguration('openclaw');
        this.baseUrl = config.get<string>('gatewayUrl', '').replace(/\/$/, '');
        this.token = config.get<string>('gatewayToken', '');
        const rawKey = config.get<string>('sessionKey', 'agent:main:main');
        // Normalise legacy "main:main" to "agent:main:main" for HTTP calls
        this.sessionKey = rawKey === 'main:main' ? 'agent:main:main' : rawKey;
        this.connected = false;
    }

    isConfigured(): boolean {
        return !!this.baseUrl && !!this.token;
    }

    isConnected(): boolean {
        return this.connected;
    }

    getStatus(): { configured: boolean; connected: boolean; url: string } {
        return {
            configured: this.isConfigured(),
            connected: this.connected,
            url: this.baseUrl
        };
    }

    onMessage(handler: (msg: OpenClawMessage) => void): vscode.Disposable {
        this.messageHandlers.push(handler);
        return {
            dispose: () => {
                const idx = this.messageHandlers.indexOf(handler);
                if (idx > -1) { this.messageHandlers.splice(idx, 1); }
            }
        };
    }

    onToolRequest(handler: (tool: PendingTool) => void): vscode.Disposable {
        this.toolRequestHandlers.push(handler);
        return {
            dispose: () => {
                const idx = this.toolRequestHandlers.indexOf(handler);
                if (idx > -1) { this.toolRequestHandlers.splice(idx, 1); }
            }
        };
    }

    private notifyHandlers(msg: OpenClawMessage) {
        this.messageHandlers.forEach(h => {
            try { h(msg); } catch {}
        });
    }

    /**
     * Call a tool via the gateway HTTP /tools/invoke endpoint.
     * Unwraps the gateway envelope and MCP content format.
     */
    private async invokeTool(tool: string, args: object): Promise<{ ok: boolean; result?: any; error?: string }> {
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/tools/invoke`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ tool, args })
            });
        } catch (err: any) {
            return { ok: false, error: err?.message || 'Network error' };
        }

        let data: any;
        try {
            data = await response.json();
        } catch {
            return { ok: false, error: `HTTP ${response.status}: non-JSON response` };
        }

        // Gateway envelope: { ok: bool, result?: ..., error?: { type, message } }
        if (!data?.ok) {
            const errMsg = typeof data?.error === 'string'
                ? data.error
                : data?.error?.message || `HTTP ${response.status}`;
            return { ok: false, error: errMsg };
        }

        let resultData = data.result;

        // MCP content format: { content: [{type:'text', text:'...'}], details?: ... }
        if (resultData?.content && Array.isArray(resultData.content)) {
            const textContent = resultData.content.find((c: any) => c.type === 'text')?.text;
            if (textContent) {
                try {
                    resultData = JSON.parse(textContent);
                } catch {
                    resultData = textContent;
                }
            }
        }

        // Error in parsed payload
        if (resultData && typeof resultData === 'object') {
            if (resultData.status === 'error' || resultData.error) {
                return { ok: false, error: resultData.error || 'Unknown tool error' };
            }
        }

        return { ok: true, result: resultData };
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        if (!this.isConfigured()) {
            return { success: false, error: 'Not configured. Set openclaw.gatewayUrl and openclaw.gatewayToken in VS Code settings.' };
        }

        try {
            const result = await this.invokeTool('sessions_list', { limit: 1 });
            if (!result.ok) {
                throw new Error(result.error || 'Unknown error');
            }
            this.connected = true;
            return { success: true };
        } catch (err) {
            this.connected = false;
            const error = err instanceof Error ? err.message : String(err);
            if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(error)) {
                return { success: false, error: 'Cannot reach OpenClaw gateway. Check your gateway URL and that the gateway is running.' };
            }
            return { success: false, error };
        }
    }

    /**
     * Send a message to the agent by calling `openclaw agent` CLI.
     * The /tools/invoke HTTP endpoint does not expose a send method,
     * so we shell out to the CLI which handles WS RPC + device auth.
     */
    async sendMessage(content: string, options?: {
        fileContext?: string;
        filePath?: string;
    }): Promise<{ success: boolean; error?: string }> {
        if (!this.isConfigured()) {
            return { success: false, error: 'Not configured' };
        }

        let fullMessage = content;
        if (options?.fileContext) {
            fullMessage = `[Working on file: ${options.filePath || 'current file'}]\n\n${content}`;
        }

        // Use the openclaw CLI to send a message (it handles WS RPC auth)
        try {
            await this.execCliSend(fullMessage);
        } catch (err: any) {
            this.connected = false;
            return { success: false, error: err?.message || 'Failed to send message via CLI' };
        }

        this.notifyHandlers({
            role: 'user',
            content,
            timestamp: new Date().toISOString()
        });

        this.connected = true;
        return { success: true };
    }

    /**
     * Run `openclaw agent -m "..." --session-key "..."` to send a message.
     * Falls back to explaining how to configure if the CLI isn't found.
     */
    private execCliSend(message: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const escaped = message.replace(/'/g, "'\\''");
            // CLI expects just the agent name (e.g., "main")
            // Extract from session key format: "agent:main:main" or "main:main" → "main"
            const parts = this.sessionKey.split(':');
            const cliSessionId = parts.length >= 2 ? parts[1] : parts[0];
            const cmd = `openclaw agent -m '${escaped}' --session-id '${cliSessionId}' --timeout 0`;
            execCb(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
                if (err) {
                    // Check if openclaw CLI is not found
                    if (/command not found|ENOENT|not recognized/i.test(err.message)) {
                        reject(new Error(
                            'openclaw CLI not found. Install it with: npm install -g openclaw'
                        ));
                        return;
                    }
                    reject(new Error(stderr?.trim() || err.message));
                    return;
                }
                resolve(stdout);
            });
        });
    }

    /**
     * Extract plain text from an OpenClaw message content field.
     * Content can be a string or an array of content blocks:
     *   [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}]
     */
    private static extractTextContent(content: any): string {
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            return content
                .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
                .map((c: any) => c.text)
                .join('\n\n');
        }
        return String(content || '');
    }

    async fetchHistory(): Promise<OpenClawMessage[]> {
        if (!this.isConfigured()) { return []; }

        try {
            const result = await this.invokeTool('sessions_history', {
                sessionKey: this.sessionKey,
                limit: 50,
                includeTools: false
            });

            if (!result.ok || !result.result) {
                return [];
            }

            let messages = result.result.messages || result.result;
            if (!Array.isArray(messages)) {
                return [];
            }

            return messages.map((m: any) => ({
                role: m.role || 'assistant',
                content: OpenClawClient.extractTextContent(m.content),
                timestamp: m.timestamp || m.ts || new Date().toISOString()
            }));
        } catch {
            // Network error during polling — swallow silently
            return [];
        }
    }

    // -- Local tool execution methods ---

    async readFile(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                return { success: false, error: 'No workspace open' };
            }
            const fullPath = path.resolve(workspaceRoot, filePath);
            if (!fullPath.startsWith(workspaceRoot)) {
                return { success: false, error: 'Path outside workspace' };
            }
            const content = fs.readFileSync(fullPath, 'utf-8');
            return { success: true, content };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    async listFiles(dirPath: string = ''): Promise<{ success: boolean; files?: string[]; error?: string }> {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                return { success: false, error: 'No workspace open' };
            }
            const fullPath = path.resolve(workspaceRoot, dirPath);
            if (!fullPath.startsWith(workspaceRoot)) {
                return { success: false, error: 'Path outside workspace' };
            }
            const entries = fs.readdirSync(fullPath, { withFileTypes: true });
            const files = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
            return { success: true, files };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    async runCommand(command: string, cwd?: string): Promise<{ success: boolean; stdout?: string; stderr?: string; error?: string }> {
        return new Promise((resolve) => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                resolve({ success: false, error: 'No workspace open' });
                return;
            }
            const options = { cwd: cwd ? path.resolve(workspaceRoot, cwd) : workspaceRoot, timeout: 30000 };
            execCb(command, options, (err: any, stdout: string, stderr: string) => {
                if (err) {
                    resolve({ success: false, stdout, stderr, error: err.message });
                } else {
                    resolve({ success: true, stdout, stderr });
                }
            });
        });
    }

    async writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                return { success: false, error: 'No workspace open' };
            }
            const fullPath = path.resolve(workspaceRoot, filePath);
            if (!fullPath.startsWith(workspaceRoot)) {
                return { success: false, error: 'Path outside workspace' };
            }
            fs.writeFileSync(fullPath, content, 'utf-8');
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
}
