#!/bin/bash
set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || echo "UNKNOWN")

echo -e "${CYAN}╔═══════════════════════════════════╗${NC}"
echo -e "${CYAN}║     SCOOP POKER - START           ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════╝${NC}"
echo ""
echo -e "  Public IP: ${GREEN}${PUBLIC_IP}${NC}"
echo ""

# Kill any existing instance on port 3001
fuser -k 3001/tcp 2>/dev/null || true
sleep 1

cd "$APP_DIR"
echo -e "  ${GREEN}Starting server...${NC}"
npx ts-node src/server.ts &
APP_PID=$!
sleep 2

if kill -0 $APP_PID 2>/dev/null; then
  echo -e "  ${GREEN}[✓] Server running (PID: $APP_PID)${NC}"
else
  echo "  [!] Server failed to start"
  exit 1
fi

echo ""
echo -e "  Access locally:  ${GREEN}http://localhost:3001${NC}"
echo -e "  Access publicly: ${GREEN}http://${PUBLIC_IP}${NC}"
echo ""
echo "  To stop: kill $APP_PID"
echo ""
