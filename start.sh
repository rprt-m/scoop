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

# Update Nginx server_name if IP changed (when running without a domain)
NGINX_CONF="/etc/nginx/sites-available/scoop-poker"
if [ -f "$NGINX_CONF" ]; then
  # Check if using catch-all server_name (no domain set)
  if grep -q "server_name _" "$NGINX_CONF"; then
    echo "  Nginx: catch-all config (no domain) — works on any IP"
  else
    CONFIGURED_DOMAIN=$(grep "server_name" "$NGINX_CONF" | head -1 | awk '{print $2}' | tr -d ';')
    echo "  Nginx: configured for domain ${CONFIGURED_DOMAIN}"
  fi
fi

# Kill any existing and start fresh with logging
echo ""
echo "  Starting server..."

# Stop systemd service if running
systemctl stop scoop-poker 2>/dev/null || true

# Kill any existing instance on port 3001
fuser -k 3001/tcp 2>/dev/null || true
sleep 1

LOG_FILE="${APP_DIR}/server.log"
echo "" > "$LOG_FILE"

cd "$APP_DIR"
echo -e "  ${GREEN}Starting server...${NC}"
echo -e "  Logs: ${LOG_FILE}"
npx ts-node src/server.ts >> "$LOG_FILE" 2>&1 &
APP_PID=$!
sleep 2

if kill -0 $APP_PID 2>/dev/null; then
  echo -e "  ${GREEN}[✓] Server running (PID: $APP_PID)${NC}"
else
  echo "  [!] Server failed to start. Check server.log"
  cat "$LOG_FILE"
  exit 1
fi

echo ""
echo -e "  Access locally:  ${GREEN}http://localhost:3001${NC}"
echo -e "  Access publicly: ${GREEN}http://${PUBLIC_IP}${NC}"
echo ""
echo "  To stop: sudo systemctl stop scoop-poker (or kill $APP_PID)"
echo ""
