#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     ${BOLD}IndieClaw Agent Installer${NC}${CYAN}         ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════╝${NC}"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

# Step 1: Check/Install Node.js
echo -e "${YELLOW}[1/5]${NC} Checking Node.js..."
if command -v node &> /dev/null; then
  NODE_VERSION=$(node -v)
  echo -e "  ${GREEN}✓${NC} Node.js ${NODE_VERSION} found"
else
  echo -e "  Installing Node.js..."
  if command -v apt-get &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
  elif command -v yum &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO yum install -y nodejs
  elif command -v dnf &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO dnf install -y nodejs
  else
    echo -e "  ${RED}✗${NC} Could not detect package manager. Install Node.js 18+ manually."
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC} Node.js $(node -v) installed"
fi

# Step 2: Install indieclaw-agent
echo -e "${YELLOW}[2/5]${NC} Installing indieclaw-agent..."
$SUDO npm install -g indieclaw-agent@latest 2>/dev/null || npm install -g indieclaw-agent@latest
AGENT_VERSION=$(node -e "try{console.log(require(require('child_process').execSync('which indieclaw-agent',{encoding:'utf8'}).trim().replace(/indieclaw-agent$/,'')+'../lib/node_modules/indieclaw-agent/package.json').version)}catch{console.log('2.0.0')}" 2>/dev/null || echo "2.0.0")
echo -e "  ${GREEN}✓${NC} indieclaw-agent v${AGENT_VERSION} installed"

# Step 3: Create systemd service
echo -e "${YELLOW}[3/5]${NC} Setting up background service..."
AGENT_PATH=$(which indieclaw-agent)
CURRENT_USER=$(whoami)

$SUDO tee /etc/systemd/system/indieclaw-agent.service > /dev/null <<EOF
[Unit]
Description=IndieClaw Agent
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
ExecStart=${AGENT_PATH}
Restart=always
RestartSec=10
Environment=INDIECLAW_PORT=3100

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable indieclaw-agent
$SUDO systemctl restart indieclaw-agent
echo -e "  ${GREEN}✓${NC} Service created and started"

# Step 4: Wait for token and detect IP
echo -e "${YELLOW}[4/5]${NC} Detecting configuration..."
sleep 2

PORT=3100
HOSTNAME=$(hostname)

# Get token
if [ -f "$HOME/.indieclaw-token" ]; then
  TOKEN=$(cat "$HOME/.indieclaw-token")
else
  echo -e "  ${YELLOW}⚠${NC} Token file not found yet. Check: cat ~/.indieclaw-token"
  TOKEN=""
fi

# Detect IP (same logic as agent: try tailscale first, fallback to network)
MACHINE_IP=""
if command -v tailscale &> /dev/null; then
  MACHINE_IP=$(tailscale ip -4 2>/dev/null || true)
fi
if [ -z "$MACHINE_IP" ]; then
  MACHINE_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ip route get 1 2>/dev/null | awk '{print $7; exit}' || echo "")
fi
if [ -z "$MACHINE_IP" ]; then
  MACHINE_IP="YOUR_SERVER_IP"
fi

echo -e "  ${GREEN}✓${NC} IP: ${MACHINE_IP}"

# Step 5: Check OpenClaw
echo -e "${YELLOW}[5/5]${NC} Checking OpenClaw..."
OPENCLAW_STATUS="not detected"
if curl -s --max-time 2 http://127.0.0.1:18789/v1/models > /dev/null 2>&1; then
  OPENCLAW_STATUS="detected on port 18789"
  echo -e "  ${GREEN}✓${NC} OpenClaw detected on port 18789"
else
  echo -e "  ${YELLOW}—${NC} OpenClaw not detected on port 18789 (optional, for AI features)"
fi

# Build deep link
DEEP_LINK="indieclaw://connect?host=${MACHINE_IP}&port=${PORT}&token=${TOKEN}&name=${HOSTNAME}&tls=0"

# Show results
echo ""
echo -e "${CYAN}╔═══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       ${BOLD}IndieClaw Agent v${AGENT_VERSION}${NC}${CYAN}          ║${NC}"
echo -e "${CYAN}╠═══════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Port:     ${BOLD}${PORT}${NC}"
echo -e "${CYAN}║${NC}  IP:       ${BOLD}${MACHINE_IP}${NC}"
echo -e "${CYAN}║${NC}  OpenClaw: ${BOLD}${OPENCLAW_STATUS}${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════╝${NC}"
echo ""

if [ -n "$TOKEN" ]; then
  echo -e "  ${BOLD}Auth Token:${NC}"
  echo -e "  ${CYAN}${TOKEN}${NC}"
  echo ""
  echo -e "  ${BOLD}Deep Link (paste in IndieClaw app → Add Machine → Paste Link):${NC}"
  echo -e "  ${CYAN}${DEEP_LINK}${NC}"
  echo ""

  # Generate QR code using the installed qrcode-terminal package
  AGENT_MODULES=$(npm root -g 2>/dev/null)/indieclaw-agent/node_modules
  if [ -d "$AGENT_MODULES/qrcode-terminal" ]; then
    echo -e "  ${BOLD}Scan with IndieClaw app:${NC}"
    echo ""
    node -e "require('${AGENT_MODULES}/qrcode-terminal').generate('${DEEP_LINK}', {small: true}, function(qr) { qr.split('\n').forEach(function(l) { console.log('  ' + l) }) })" 2>/dev/null || true
    echo ""
  fi
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""
echo -e "  Useful commands:"
echo -e "    Status:  ${BOLD}sudo systemctl status indieclaw-agent${NC}"
echo -e "    Logs:    ${BOLD}sudo journalctl -u indieclaw-agent -f${NC}"
echo -e "    Restart: ${BOLD}sudo systemctl restart indieclaw-agent${NC}"
echo -e "    Remove:  ${BOLD}sudo systemctl stop indieclaw-agent && sudo systemctl disable indieclaw-agent${NC}"
echo ""
