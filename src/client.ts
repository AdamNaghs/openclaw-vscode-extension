import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
    private sessionKey: string = 'main:main';
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
        this.sessionKey = config.get<string>('sessionKey', 'main:main');
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
                if (idx > -1) this.messageHandlers.splice(idx, 1);
            }
        };
    }

    onToolRequest(handler: (tool: PendingTool) => void): vscode.Disposable {
        this.toolRequestHandlers.push(handler);
        return {
            dispose: () => {
                const idx = this.toolRequestHandlers.indexOf(handler);
                if (idx > -1) this.toolRequestHandlers.splice(idx, 1);
            }
        };
    }

    private notifyHandlers(msg: OpenClawMessage) {
        this.messageHandlers.forEach(h => {
            try { h(msg); } catch {}
        });
    }

    private notifyToolRequest(tool: PendingTool) {
        this.toolRequestHandlers.forEach(h => {
            try { h(tool); } catch {}
        });
    }

    private async invokeTool(tool: string, args: object): Promise<{ ok: boolean; result?: any; error?: string }> {
        const response = await fetch(`${this.baseUrl}/tools/invoke`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify({
                tool,
                args,
                sessionKey: this.sessionKey
            })
        });

        const data = await response.json() as any;
        
        // Handle wrapped response format from gateway
        // { content: [{type: 'text', text: '...'}], details: {...} }
        let resultData = data;
        if (data.content && Array.isArray(data.content)) {
            // Try to parse the text content as JSON
            const textContent = data.content.find((c: any) => c.type === 'text')?.text;
            if (textContent) {
                try {
                    resultData = JSON.parse(textContent);
                } catch {
                    resultData = { result: textContent };
                }
            }
        }
        
        // Check for error in parsed data
        if (resultData.status === 'error' || resultData.error) {
            return { 
                ok: false, 
                error: resultData.error || 'Unknown error' 
            };
        }
        
        return { ok: true, result: resultData.result || resultData };
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        if (!this.isConfigured()) {
            return { success: false, error: 'Not configured. Set gateway URL and token.' };
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
            if (error.includes('fetch failed') || error.includes('ENOTFOUND') || error.includes('ECONNREFUSED')) {
                return { success: false, error: 'Cannot connect to OpenClaw gateway. Are you on your Tailnet?' };
            }
            return { success: false, error };
        }
    }

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

        const result = await this.invokeTool('sessions_send', {
            sessionKey: this.sessionKey,
            message: fullMessage,
            timeoutSeconds: 0
        });

        if (!result.ok) {
            this.connected = false;
            return { success: false, error: result.error };
        }

        this.notifyHandlers({
            role: 'user',
            content: content,
            timestamp: new Date().toISOString()
        });

        this.connected = true;
        return { success: true };
    }

    async fetchHistory(): Promise<OpenClawMessage[]> {
        if (!this.isConfigured()) return [];

        const result = await this.invokeTool('sessions_history', {
            sessionKey: this.sessionKey,
            limit: 50,
            includeTools: false
        });

        if (!result.ok || !result.result) {
            console.log('[OpenClaw] fetchHistory failed:', result.error || 'No result');
            return [];
        }

        // Debug: log what we got
        console.log('[OpenClaw] fetchHistory result:', JSON.stringify(result.result).slice(0, 500));

        // Handle different response formats
        let messages = result.result.messages || result.result;
        if (!Array.isArray(messages)) {
            console.log('[OpenClaw] messages is not array, got:', typeof messages);
            messages = [];
        }
        
        return messages.map((m: any) => ({
            role: m.role || 'assistant',
            content: m.content || m.text || '',
            timestamp: m.timestamp || m.ts || new Date().toISOString()
        }));
    }

    // Local tool execution methods (like Claude Code)
    
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

            const exec = require('child_process').exec;
            const options = { cwd: cwd ? path.resolve(workspaceRoot, cwd) : workspaceRoot, timeout: 30000 };
            
            exec(command, options, (err: any, stdout: string, stderr: string) => {
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
