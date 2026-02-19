# OpenClaw - VS Code Extension

Connect VS Code to your OpenClaw agent via Tailscale.

## Features

- **Chat panel**: Full conversation history with your agent
- **Right-click code actions**: Ask OpenClaw, Explain code, Fix code
- **Secure by design**: Only works on your Tailnet — no external exposure
- **Send messages**: Uses `openclaw agent` CLI for reliable delivery

## Installation

### 1. Prerequisites

- **OpenClaw CLI** installed: `npm install -g openclaw`
- **OpenClaw Gateway** running: `openclaw gateway start`
- **Tailscale** connected (if accessing gateway remotely)

### 2. Build and install the extension

```bash
git clone https://github.com/AdamNaghs/openclaw-vscode-extension.git
cd openclaw-vscode-extension
npm install
npm run compile
npm install -g @vscode/vsce   # if not already installed
vsce package
code --install-extension openclaw-0.1.0.vsix
```

Or for development mode:
```bash
# Press F5 in VS Code with this folder open
```

### 3. Configure VS Code settings

Open VS Code settings (Cmd+, or Ctrl+,) and search for "openclaw":

| Setting | Description | Example |
|---------|-------------|---------|
| `openclaw.gatewayUrl` | Your OpenClaw Gateway URL | `http://your-machine.tailnet.ts.net:18789` |
| `openclaw.gatewayToken` | Gateway authentication token | (from `~/.openclaw/openclaw.json` → `gateway.auth.token`) |
| `openclaw.sessionKey` | Session key | `agent:main:main` (default) |

**Finding your gateway URL and token:**
```bash
# Gateway port (default 18789)
cat ~/.openclaw/openclaw.json | grep -A2 '"gateway"'

# Auth token
cat ~/.openclaw/openclaw.json | python3 -c "import sys,json; print(json.load(sys.stdin)['gateway']['auth']['token'])"

# If using Tailscale, get your machine's Tailnet hostname
tailscale status
```

## Usage

### Chat panel
1. Open Command Palette (Cmd+Shift+P) → "OpenClaw: Open OpenClaw"
2. Type messages in the input area and press Enter
3. Messages are sent via `openclaw agent` CLI and responses appear via polling

### Right-click actions
1. Select code in editor
2. Right-click → "Ask OpenClaw" / "Explain this code" / "Fix issues in this code"

### Apply edits
When OpenClaw suggests code in a code block, click "Apply Edit" to insert it into your active editor.

## Architecture

```
VS Code Extension
    |
    |── HTTP /tools/invoke ──→ OpenClaw Gateway
    |   (sessions_list)            (connection test)
    |   (sessions_history)         (fetch messages, polling every 3s)
    |
    |── openclaw agent CLI ──→ Gateway WS RPC
        (send messages)            (chat.send with device auth)
```

**Reading messages**: Uses the HTTP `/tools/invoke` endpoint with bearer token auth to call `sessions_list` (connection test) and `sessions_history` (message polling).

**Sending messages**: Uses the `openclaw agent -m "..." --session-key "..."` CLI command, which handles WebSocket RPC with full device authentication automatically.

## Troubleshooting

### "Cannot reach OpenClaw gateway"
- Check gateway is running: `openclaw gateway status`
- If remote: verify Tailscale is connected: `tailscale status`
- Verify the URL and port in settings match your config

### "Not configured"
- Set both `openclaw.gatewayUrl` and `openclaw.gatewayToken` in VS Code settings

### "openclaw CLI not found"
- Install: `npm install -g openclaw`
- Ensure it's in your PATH: `which openclaw`

### No messages showing
- Check your session key is correct (default: `agent:main:main`)
- Verify the session exists: `openclaw sessions list`
- Old configs may use `main:main` — update to `agent:main:main`

### Messages appear but sending fails
- The CLI must be installed and configured on the same machine as VS Code
- Run `openclaw agent -m "test" --session-key agent:main:main` manually to verify

## Development

```bash
npm run watch     # Watch mode for TypeScript compilation
# Press F5 in VS Code to launch Extension Development Host
```
