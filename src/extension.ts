import * as vscode from 'vscode';
import { OpenClawPanel } from './panel';
import { OpenClawClient } from './client';

let client: OpenClawClient;
let panel: OpenClawPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('OpenClaw extension activating...');

    client = new OpenClawClient();

    const config = vscode.workspace.getConfiguration('openclaw');
    const gatewayUrl = config.get<string>('gatewayUrl');
    
    if (!gatewayUrl) {
        vscode.window.showWarningMessage(
            'OpenClaw: Configure your Tailscale gateway URL in settings',
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'openclaw');
            }
        });
    }

    const openPanelCmd = vscode.commands.registerCommand('openclaw.openPanel', () => {
        if (panel) {
            panel.reveal();
        } else {
            panel = new OpenClawPanel(context.extensionUri, client);
            panel.show();
        }
    });

    const askCmd = vscode.commands.registerCommand('openclaw.ask', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showInformationMessage('Select some code first');
            return;
        }
        await openPanelWithQuery(context, client, `Review this code:\n\n\`\`\`\n${selection}\n\`\`\``);
    });

    const explainCmd = vscode.commands.registerCommand('openclaw.explain', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.document.getText(editor.selection);
        if (!selection) return;
        await openPanelWithQuery(context, client, `Explain this code:\n\n\`\`\`\n${selection}\n\`\`\``);
    });

    const fixCmd = vscode.commands.registerCommand('openclaw.fix', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.document.getText(editor.selection);
        if (!selection) return;
        await openPanelWithQuery(context, client, `Find and fix any issues in this code:\n\n\`\`\`\n${selection}\n\`\`\``);
    });

    context.subscriptions.push(openPanelCmd, askCmd, explainCmd, fixCmd);
    vscode.commands.executeCommand('setContext', 'openclaw.enabled', true);

    console.log('OpenClaw extension activated');
}

async function openPanelWithQuery(
    context: vscode.ExtensionContext,
    client: OpenClawClient,
    query: string
) {
    if (!panel) {
        panel = new OpenClawPanel(context.extensionUri, client);
    }
    panel.show();
    panel.sendQuery(query);
}

export function deactivate() {
    panel?.dispose();
}
