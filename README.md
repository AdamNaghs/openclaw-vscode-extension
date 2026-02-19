# OpenClaw - VS Code Extension

Connect VS Code to your OpenClaw agent via Tailscale.

## Features

- **Right-click code actions**: Ask OpenClaw, Explain code, Fix code
- **Inline chat panel**: Full conversation history with your agent
- **Secure by design**: Only works on your Tailnet — no external exposure
- **Full context**: Access to MEMORY.md, conversation history, your preferences

## Installation

### 1. Build the extension

```bash
cd projects/openclaw-vscode
npm install
npm run compile
```

### 2. Install in VS Code

Option A: Development mode
```bash
code --extensionDevelopmentPath=/home/linuxbrew/.openclaw/workspace/projects/openclaw-vscode
```

Option B: Package and install
```bash
npm install -g @vscode/vsce
vsce package
code --install-extension openclaw-0.1.0.vsix
```

## Configuration

Open VS Code settings and configure:

| Setting | Description | Example |
|---------|-------------|---------|
| `openclaw.gatewayUrl` | Your OpenClaw Gateway Tailscale URL | `http://your-machine.tailnet-name.ts.net:18789` |
| `openclaw.gatewayToken` | Your gateway authentication token | `sk-...` |
| `openclaw.sessionKey` | Session to connect to | `main:main` |

### Finding your settings:

1. **Gateway URL**: Check your Tailscale admin console for your machine's Tailnet address. The Gateway runs on port `18789` by default.
2. **Gateway Token**: Check your OpenClaw config (`~/.openclaw/openclaw.json`) for the token under `gateway.auth.token`
3. **Tailscale requirement**: The extension will fail to connect if you're not on your Tailnet

## Usage

### Chat panel
- Open Command Palette → "OpenClaw: Open OpenClaw"
- Type messages and get responses from OpenClaw

### Right-click actions
1. Select code in editor
2. Right-click → "Ask OpenClaw" / "Explain this code" / "Fix issues"

### Apply edits
When OpenClaw suggests code changes, click "Apply Edit" to apply them directly to your file.

## Security

- **Tailnet-only**: Extension only connects via Tailscale — if you're not on the Tailnet, it fails closed
- **Token auth**: All requests include your gateway token via `Authorization: Bearer` header
- **No cloud**: Nothing leaves your infrastructure

## Troubleshooting

### "Cannot connect to OpenClaw gateway"
- Check you're connected to Tailscale: `tailscale status`
- Verify the gateway URL is correct (port 18789 by default)
- Ensure OpenClaw gateway is running: `openclaw gateway status`

### "Not configured"
- Set `openclaw.gatewayUrl` and `openclaw.gatewayToken` in VS Code settings

## Architecture

```
VS Code Extension ←→ Tailscale network ←→ OpenClaw Gateway
        ↓                                      |
   HTTP POST /tools/invoke                     |
        ↓                                      ↓
   sessions_send tool                    Agent (main:main)
   sessions_history tool                       |
                                        MEMORY.md loaded
```

The extension uses OpenClaw's HTTP `/tools/invoke` endpoint to:
- Call `sessions_send` to send messages to your session
- Call `sessions_history` to fetch conversation history

The extension polls for new messages every 2 seconds using `sessions_history`.

## Correct API Usage (per OpenClaw docs)

Based on the OpenClaw documentation:

```
POST /tools/invoke
Authorization: Bearer <token>
Content-Type: application/json

{
  "tool": "sessions_send",
  "args": {
    "sessionKey": "main:main",
    "message": "Your message here",
    "timeoutSeconds": 0
  },
  "sessionKey": "main:main"
}
```

## Development

```bash
# Watch mode
npm run watch

# Test in VS Code
F5 (Run Extension)
```
