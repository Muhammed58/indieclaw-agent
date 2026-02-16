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
echo -e "${YELLOW}[1/4]${NC} Checking Node.js..."
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
echo -e "${YELLOW}[2/4]${NC} Installing indieclaw-agent..."
$SUDO npm install -g indieclaw-agent 2>/dev/null || npm install -g indieclaw-agent
echo -e "  ${GREEN}✓${NC} indieclaw-agent installed"

# Step 3: Create systemd service
echo -e "${YELLOW}[3/4]${NC} Setting up background service..."
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
$SUDO systemctl start indieclaw-agent
echo -e "  ${GREEN}✓${NC} Service created and started"

# Step 4: Wait for token to be generated
sleep 2

# Show token
echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""

if [ -f "$HOME/.indieclaw-token" ]; then
  TOKEN=$(cat "$HOME/.indieclaw-token")
  echo -e "  ${GREEN}${BOLD}Setup complete!${NC}"
  echo ""
  echo -e "  Your auth token:"
  echo ""
  echo -e "  ${BOLD}${CYAN}${TOKEN}${NC}"
  echo ""
  echo -e "  Copy this token into the IndieClaw app."
  echo -e "  Port: ${BOLD}3100${NC}"
else
  echo -e "  ${GREEN}${BOLD}Setup complete!${NC}"
  echo ""
  echo -e "  Run this to see your token:"
  echo -e "  ${BOLD}cat ~/.indieclaw-token${NC}"
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
