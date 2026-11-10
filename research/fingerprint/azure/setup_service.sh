#!/bin/bash
# Runs ON the Azure server. Args: <public host name>. The token arrives on stdin and is stored only in a root-only file.
set -euo pipefail
HOST="$1"
read -r TOKEN
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
printf 'FP_SERVER_TOKEN=%s\n' "$TOKEN" | sudo tee /etc/fp-service.env >/dev/null
sudo chmod 600 /etc/fp-service.env
sudo tee /etc/systemd/system/fp-service.service >/dev/null <<'UNIT'
[Unit]
Description=MAD fingerprint check service
After=network-online.target
Wants=network-online.target

[Service]
User=azureuser
EnvironmentFile=/etc/fp-service.env
ExecStart=/usr/bin/python3 /home/azureuser/code/fp_service.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOST {
	reverse_proxy 127.0.0.1:8080
}
CADDY
sudo systemctl daemon-reload
sudo systemctl enable --now fp-service
sudo systemctl restart caddy
sudo systemctl is-enabled caddy fp-service | tr '\n' ' '
echo; rm -rf ~/test ~/cold.txt ~/cold.json ~/azure.json ~/list.txt ~/getfiles.sh ~/bootstrap.sh
echo "SERVICE INSTALLED"
