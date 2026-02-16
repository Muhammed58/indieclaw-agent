# IndieClaw Agent

Manage your server from your phone. This is the server-side agent for the [IndieClaw](https://github.com/Muhammed58/indieclaw) mobile app.

## Quick Start

```bash
npx indieclaw-agent
```

That's it. The agent starts a WebSocket server on port 3100 and prints an auth token. Enter the token in the IndieClaw mobile app to connect.

## What It Does

The agent runs on your server and lets the mobile app:

- **Dashboard** — CPU, RAM, disk usage, uptime
- **File Browser** — Browse, read, and edit files
- **Docker** — List containers, view logs, start/stop/restart
- **Terminal** — Full interactive shell (requires `node-pty`)
- **Cron Jobs** — View scheduled tasks

## Requirements

- **Node.js 18+**
- **Docker** (optional — for container management)
- **node-pty build tools** (optional — for interactive terminal)

## Install Globally (alternative)

```bash
npm install -g indieclaw-agent
indieclaw-agent
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `INDIECLAW_PORT` | `3100` | WebSocket server port |
| `INDIECLAW_TOKEN` | auto-generated | Custom auth token |

```bash
# Custom port
INDIECLAW_PORT=4000 npx indieclaw-agent

# Custom token
INDIECLAW_TOKEN=mysecrettoken npx indieclaw-agent
```

## Network Setup

Your phone needs to reach the agent. Options:

| Method | Connection URL | Setup |
|--------|---------------|-------|
| **Tailscale** (recommended) | `ws://100.x.x.x:3100` | Install Tailscale on both devices |
| **Direct IP** | `ws://your-vps-ip:3100` | Open port 3100 in firewall |
| **Local network** | `ws://192.168.x.x:3100` | Same WiFi, no setup needed |

## Interactive Terminal

For the full terminal feature, the agent needs `node-pty` which requires native build tools:

```bash
# Ubuntu/Debian
sudo apt install build-essential python3

# macOS
xcode-select --install

# Then install globally for best results
npm install -g indieclaw-agent
```

Without `node-pty`, everything works except the Terminal tab. The agent will show a message on startup if it's not available.

## Security

- Auth token is generated on first run and stored in `~/.indieclaw-token`
- All WebSocket messages require authentication
- The agent only listens for connections — it never phones home
- Use Tailscale or a firewall to restrict who can reach port 3100

## Run as a Service (systemd)

```bash
sudo tee /etc/systemd/system/indieclaw-agent.service > /dev/null <<EOF
[Unit]
Description=IndieClaw Agent
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=$(which npx) indieclaw-agent
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable indieclaw-agent
sudo systemctl start indieclaw-agent
```

## License

MIT
