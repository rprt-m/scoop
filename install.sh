#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔═══════════════════════════════════════╗"
echo "║       SCOOP POKER - INSTALLER         ║"
echo "╚═══════════════════════════════════════╝"
echo -e "${NC}"

# Must run as root for nginx/systemd/certbot
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[!] Please run as root: sudo ./install.sh${NC}"
  exit 1
fi

# Get the actual user (not root)
REAL_USER="${SUDO_USER:-$USER}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo -e "${YELLOW}[?] Configuration${NC}"
echo ""

# Domain
read -p "  Domain name (leave blank for IP-only access): " DOMAIN
DOMAIN="${DOMAIN:-}"

# Protocol
echo ""
echo "  Protocol options:"
echo "    1) HTTP only (port 80)"
echo "    2) HTTPS only (port 443 with Let's Encrypt)"
echo "    3) Both HTTP and HTTPS (HTTP redirects to HTTPS)"
echo "    4) Both HTTP and HTTPS (no redirect, serve both)"
read -p "  Choose [1-4]: " PROTO_CHOICE
PROTO_CHOICE="${PROTO_CHOICE:-1}"

# Port for Node app
read -p "  Node.js app port (default 3000): " APP_PORT
APP_PORT="${APP_PORT:-3000}"

# Ante
read -p "  Default ante amount (default 5): " ANTE
ANTE="${ANTE:-5}"

# Email for certbot
if [ "$PROTO_CHOICE" != "1" ]; then
  read -p "  Email for Let's Encrypt SSL (required for HTTPS): " CERT_EMAIL
fi

echo ""
echo -e "${GREEN}[*] Installing system dependencies...${NC}"

# Update and install
apt-get update -qq

# Node.js
if ! command -v node &> /dev/null; then
  echo -e "${CYAN}  Installing Node.js 20.x...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo -e "${GREEN}  [✓] Node.js $(node --version) already installed${NC}"
fi

# Nginx
if ! command -v nginx &> /dev/null; then
  echo -e "${CYAN}  Installing Nginx...${NC}"
  apt-get install -y nginx
else
  echo -e "${GREEN}  [✓] Nginx already installed${NC}"
fi

# Certbot (if HTTPS)
if [ "$PROTO_CHOICE" != "1" ]; then
  if ! command -v certbot &> /dev/null; then
    echo -e "${CYAN}  Installing Certbot...${NC}"
    apt-get install -y certbot python3-certbot-nginx
  else
    echo -e "${GREEN}  [✓] Certbot already installed${NC}"
  fi
fi

# Install npm dependencies
echo ""
echo -e "${GREEN}[*] Installing app dependencies...${NC}"
cd "$APP_DIR"
sudo -u "$REAL_USER" npm install

# Create systemd service
echo ""
echo -e "${GREEN}[*] Creating systemd service...${NC}"

cat > /etc/systemd/system/scoop-poker.service << EOF
[Unit]
Description=Scoop Poker Server
After=network.target

[Service]
Type=simple
User=$REAL_USER
WorkingDirectory=$APP_DIR
ExecStart=$(which npx) ts-node src/server.ts
Restart=always
RestartSec=5
Environment=PORT=$APP_PORT
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable scoop-poker
systemctl restart scoop-poker

echo -e "${GREEN}  [✓] scoop-poker.service created and started${NC}"

# Configure Nginx
echo ""
echo -e "${GREEN}[*] Configuring Nginx...${NC}"

SERVER_NAME="${DOMAIN:-_}"

# Remove default site if it exists
rm -f /etc/nginx/sites-enabled/default

# Write nginx config
cat > /etc/nginx/sites-available/scoop-poker << EOF
# Scoop Poker - Nginx Configuration

map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
}

EOF

if [ "$PROTO_CHOICE" = "1" ]; then
  # HTTP only
  cat >> /etc/nginx/sites-available/scoop-poker << EOF
server {
    listen 80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
EOF

elif [ "$PROTO_CHOICE" = "2" ]; then
  # HTTPS only (with HTTP redirect)
  cat >> /etc/nginx/sites-available/scoop-poker << EOF
server {
    listen 80;
    server_name $SERVER_NAME;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $SERVER_NAME;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
EOF

elif [ "$PROTO_CHOICE" = "3" ]; then
  # Both, HTTP redirects to HTTPS
  cat >> /etc/nginx/sites-available/scoop-poker << EOF
server {
    listen 80;
    server_name $SERVER_NAME;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $SERVER_NAME;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
EOF

elif [ "$PROTO_CHOICE" = "4" ]; then
  # Both, no redirect
  cat >> /etc/nginx/sites-available/scoop-poker << EOF
server {
    listen 80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}

server {
    listen 443 ssl;
    server_name $SERVER_NAME;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
EOF
fi

# Enable site
ln -sf /etc/nginx/sites-available/scoop-poker /etc/nginx/sites-enabled/scoop-poker

# Get SSL cert if needed (before nginx starts with ssl config)
if [ "$PROTO_CHOICE" != "1" ] && [ -n "$DOMAIN" ]; then
  echo ""
  echo -e "${GREEN}[*] Obtaining SSL certificate...${NC}"
  
  # Temporarily use HTTP-only config for certbot verification
  cat > /etc/nginx/sites-available/scoop-poker-temp << EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/scoop-poker-temp /etc/nginx/sites-enabled/scoop-poker-temp
  rm -f /etc/nginx/sites-enabled/scoop-poker
  nginx -t && systemctl restart nginx

  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$CERT_EMAIL" --redirect

  # Remove temp config, restore real config
  rm -f /etc/nginx/sites-available/scoop-poker-temp
  rm -f /etc/nginx/sites-enabled/scoop-poker-temp
  ln -sf /etc/nginx/sites-available/scoop-poker /etc/nginx/sites-enabled/scoop-poker
fi

# Test and reload nginx
nginx -t && systemctl restart nginx
echo -e "${GREEN}  [✓] Nginx configured and running${NC}"

# Open firewall if ufw is active
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
  echo ""
  echo -e "${GREEN}[*] Configuring firewall (ufw)...${NC}"
  ufw allow 80/tcp
  ufw allow 443/tcp
  echo -e "${GREEN}  [✓] Ports 80 and 443 opened${NC}"
fi

# Summary
echo ""
echo -e "${CYAN}"
echo "╔═══════════════════════════════════════╗"
echo "║       INSTALLATION COMPLETE!          ║"
echo "╚═══════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo "  App service:  scoop-poker.service"
echo "  App port:     $APP_PORT (internal)"
echo ""

if [ -n "$DOMAIN" ]; then
  if [ "$PROTO_CHOICE" = "1" ]; then
    echo "  Access:       http://$DOMAIN"
  elif [ "$PROTO_CHOICE" = "4" ]; then
    echo "  Access:       http://$DOMAIN"
    echo "                https://$DOMAIN"
  else
    echo "  Access:       https://$DOMAIN"
  fi
else
  PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_IP")
  echo "  Access:       http://$PUBLIC_IP"
fi

echo ""
echo "  Useful commands:"
echo "    sudo systemctl status scoop-poker    # Check app status"
echo "    sudo systemctl restart scoop-poker   # Restart app"
echo "    sudo journalctl -u scoop-poker -f    # View logs"
echo "    sudo systemctl restart nginx         # Restart nginx"
echo ""
