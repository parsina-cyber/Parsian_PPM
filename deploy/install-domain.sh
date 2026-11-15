#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DOMAIN=crm.parsian-ppm.com
EXPECTED_IP=37.32.24.138
APP_SHA=8bf5a4c60f9ff98648182e2d912f3a8d57c82495
APP_REPO=https://github.com/parsina-cyber/Parsian_PPM.git
BASE=/opt/parsian-crm
STATE=/var/lib/parsian-crm
RELEASE="$BASE/releases/$APP_SHA"
NGINX_SITE=/etc/nginx/sites-available/parsian-crm.conf
SITE_LINK=/etc/nginx/sites-enabled/parsian-crm.conf
CREATED_SITE=0
STARTED_SERVICE=0
WORK=''

fail() { printf '\nERROR: %s\n' "$*" >&2; rollback; exit 1; }
log() { printf '\n== %s ==\n' "$*"; }
cleanup() { [[ -z "$WORK" ]] || rm -rf -- "$WORK"; }
on_error() {
  local rc=$?
  trap - ERR
  printf '\nInstallation did not complete. Existing CRM data was retained. Exit code: %s\n' "$rc" >&2
  rollback
  exit "$rc"
}
rollback() {
  if [[ "$CREATED_SITE" == 1 ]]; then
    CREATED_SITE=0
    rm -f -- "$SITE_LINK" || true
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx || true; fi
  fi
  if [[ "$STARTED_SERVICE" == 1 ]]; then
    STARTED_SERVICE=0
    systemctl stop parsian-crm || true
  fi
}
supported_os() {
  case "$1:$2" in ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) return 0 ;; *) return 1 ;; esac
}
check_platform() {
  [[ -r /etc/os-release ]] || fail 'Cannot identify the operating system.'
  local ID='' VERSION_ID=''
  . /etc/os-release
  supported_os "$ID" "$VERSION_ID" || fail "Unsupported OS: $ID $VERSION_ID. No packages were installed."
  [[ -d /run/systemd/system ]] || fail 'A running systemd server is required.'
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) fail 'Only x86_64 and arm64 are supported.' ;; esac
}
check_existing_services() {
  command -v ss >/dev/null || fail 'The ss utility is required for the read-only port checks.'
  local port listeners
  for port in 80 443; do
    listeners=$(ss -ltnp "sport = :$port" | tail -n +2)
    if [[ -n "$listeners" ]] && ! grep -q nginx <<<"$listeners"; then
      fail "Port $port is occupied by another service. Inspect that service before installing a reverse proxy."
    fi
  done
  [[ -z "$(ss -ltn 'sport = :3000' | tail -n +2)" ]] || fail 'Port 3000 is already occupied; inspect the existing application first.'
  [[ ! -e /etc/systemd/system/parsian-crm.service && ! -e "$BASE/current" ]] || fail 'An existing CRM installation was found. Use a reviewed upgrade procedure instead.'
  [[ ! -e "$NGINX_SITE" && ! -e "$SITE_LINK" && ! -L "$SITE_LINK" ]] || fail 'An existing CRM virtual host was found.'
  if command -v nginx >/dev/null; then
    nginx -t
    if nginx -T 2>/dev/null | grep -F "$DOMAIN" >/dev/null; then fail 'The domain already appears in Nginx; inspect its current configuration first.'; fi
  fi
}
check_dns() {
  local addresses
  addresses=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u) || fail 'Domain DNS could not be resolved.'
  [[ "$addresses" == "$EXPECTED_IP" ]] || fail 'Set the Cloudflare A record to the server IP and keep it DNS-only for the initial certificate setup.'
}
install_missing_packages() {
  local missing=() p status
  for p in ca-certificates curl git xz-utils nginx certbot python3-certbot-nginx; do
    status=$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null || true)
    [[ "$status" == 'install ok installed' ]] || missing+=("$p")
  done
  if ((${#missing[@]})); then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y "${missing[@]}"
  fi
}
install_node() {
  # Isolate Node from runtimes used by any existing website.
  local filename expected
  curl -fsSL --retry 1 --max-time 60 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$WORK/SHASUMS256.txt"
  filename=$(awk -v arch="$ARCH" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' "$WORK/SHASUMS256.txt")
  [[ -n "$filename" ]] || fail 'Official Node.js 24 release was not found.'
  expected=$(awk -v name="$filename" '$2==name {print $1}' "$WORK/SHASUMS256.txt")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid official checksum.'
  curl -fsSL --retry 1 --max-time 240 "https://nodejs.org/dist/latest-v24.x/$filename" -o "$WORK/$filename"
  (cd "$WORK"; printf '%s  %s\n' "$expected" "$filename" | sha256sum -c -)
  install -d -m 755 "$BASE/runtime/node"
  tar -xJf "$WORK/$filename" --strip-components=1 -C "$BASE/runtime/node"
  NODE="$BASE/runtime/node/bin/node"
  "$NODE" -e "if(+process.versions.node.split('.')[0]<24)process.exit(1);require('node:sqlite')"
}
bootstrap_manager() {
  local status admin_name admin_username admin_password confirmation
  status=$(curl -fsS http://127.0.0.1:3000/api/session)
  if "$NODE" -e 'const s=JSON.parse(process.argv[1]);process.exit(s.needsSetup?0:1)' "$status"; then
    [[ -r /dev/tty ]] || fail 'Interactive console required to create the first sales manager before publishing the app.'
    printf '\nCreate the first CRM sales manager. These are CRM credentials, not server credentials.\n'
    read -r -p 'Manager display name: ' admin_name </dev/tty
    read -r -p 'Username (3+ English characters): ' admin_username </dev/tty
    [[ -n "$admin_name" && "$admin_username" =~ ^[A-Za-z0-9_.-]{3,50}$ ]] || fail 'Invalid manager name or username.'
    read -r -s -p 'New CRM password (8-128 characters): ' admin_password </dev/tty; printf '\n'
    read -r -s -p 'Repeat new CRM password: ' confirmation </dev/tty; printf '\n'
    [[ ${#admin_password} -ge 8 && ${#admin_password} -le 128 && "$admin_password" == "$confirmation" ]] || fail 'Passwords must match and contain 8-128 characters.'
    CRM_ADMIN_NAME="$admin_name" CRM_ADMIN_USERNAME="$admin_username" CRM_ADMIN_PASSWORD="$admin_password" "$NODE" --input-type=module - <<'JS'
const response=await fetch('http://127.0.0.1:3000/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:process.env.CRM_ADMIN_NAME,username:process.env.CRM_ADMIN_USERNAME,password:process.env.CRM_ADMIN_PASSWORD})});
if(!response.ok)throw Error('Manager initialization failed: HTTP '+response.status);
console.log('Manager account created; password was not saved in a config file.');
JS
    unset admin_password confirmation
  fi
}
main() {
  [[ "${1:-}" != --help ]] || { printf 'Run this installer as root in the target server console. It configures only crm.parsian-ppm.com.\n'; return; }
  [[ $EUID -eq 0 ]] || fail 'Run with sudo from the target server console.'
  check_platform
  check_existing_services
  check_dns
  command -v flock >/dev/null || fail 'flock is required.'
  exec 9>/run/lock/parsian-crm-install.lock
  flock -n 9 || fail 'Another CRM installation is running.'
  WORK=$(mktemp -d /tmp/parsian-crm-install.XXXXXX)
  trap cleanup EXIT
  trap on_error ERR
  local stamp backup email
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="/var/backups/parsian-crm/$stamp"
  install -d -m 700 "$backup"
  [[ ! -d /etc/nginx ]] || cp -a /etc/nginx "$backup/nginx"
  log 'Installing missing dependencies'
  install_missing_packages
  log 'Installing isolated Node.js with official checksum verification'
  install_node
  log 'Fetching tested CRM version 2'
  git clone --single-branch --branch release/parsian-crm-v2 "$APP_REPO" "$WORK/source"
  git -C "$WORK/source" checkout --detach "$APP_SHA"
  [[ "$(git -C "$WORK/source" rev-parse HEAD)" == "$APP_SHA" ]] || fail 'Source revision mismatch.'
  (cd "$WORK/source"; "$NODE" --test)
  [[ ! -e "$RELEASE" ]] || fail 'Release directory already exists; inspect the previous attempt before retrying.'
  install -d -m 755 "$BASE" "$BASE/releases"
  mv "$WORK/source" "$RELEASE"
  chmod -R u=rwX,go=rX "$RELEASE"
  id parsian-crm >/dev/null 2>&1 || useradd --system --user-group --home-dir "$STATE" --shell /usr/sbin/nologin parsian-crm
  install -d -o parsian-crm -g parsian-crm -m 700 "$STATE"
  if [[ -f "$STATE/crm.sqlite" ]]; then
    CRM_BACKUP_PATH="$backup/crm.sqlite" "$NODE" --input-type=module - <<'JS'
import {DatabaseSync,backup} from 'node:sqlite';
const db=new DatabaseSync('/var/lib/parsian-crm/crm.sqlite',{readOnly:true});await backup(db,process.env.CRM_BACKUP_PATH);db.close();
JS
  fi
  chown -R parsian-crm:parsian-crm "$STATE"
  ln -s "$RELEASE" "$BASE/current"
  install -d -o root -g parsian-crm -m 750 /etc/parsian-crm
  printf 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\nDB_PATH=/var/lib/parsian-crm/crm.sqlite\nCOOKIE_SECURE=1\n' > /etc/parsian-crm/production.env
  chown root:parsian-crm /etc/parsian-crm/production.env;chmod 640 /etc/parsian-crm/production.env
  cat > /etc/systemd/system/parsian-crm.service <<UNIT
[Unit]
Description=Parsian CRM
After=network.target
[Service]
Type=simple
User=parsian-crm
Group=parsian-crm
WorkingDirectory=$BASE/current
EnvironmentFile=/etc/parsian-crm/production.env
ExecStart=$NODE $BASE/current/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
StateDirectory=parsian-crm
StateDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  STARTED_SERVICE=1
  systemctl start parsian-crm
  local ready=0 attempt
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:3000/api/session > "$WORK/session.json"; then ready=1;break;fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || fail 'App did not start; inspect journalctl -u parsian-crm.'
  bootstrap_manager
  [[ -r /dev/tty ]] || fail 'Interactive console required for certificate contact email.'
  read -r -p 'Email for HTTPS certificate renewal notices: ' email </dev/tty
  [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail 'Invalid certificate contact email.'
  cat > "$NGINX_SITE" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 128k;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  ln -s "$NGINX_SITE" "$SITE_LINK";CREATED_SITE=1
  nginx -t
  systemctl start nginx
  systemctl reload nginx
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 80/tcp;ufw allow 443/tcp;fi
  log 'Issuing HTTPS certificate; cloud firewall ports 80 and 443 must be open'
  certbot --nginx --non-interactive --agree-tos --email "$email" --redirect -d "$DOMAIN"
  nginx -t;systemctl reload nginx
  curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/session" -o "$WORK/verified-session.json"
  "$NODE" -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1]));if(s.version!=="2.0.0"||s.needsSetup)process.exit(1)' "$WORK/verified-session.json"
  systemctl enable parsian-crm nginx
  systemctl enable --now certbot.timer
  trap - ERR
  printf '\nInstallation complete: https://%s\nDatabase: %s/crm.sqlite\nPre-install configuration backup: %s\n' "$DOMAIN" "$STATE" "$backup"
  printf 'Verify access from your laptop. Cloud firewall rules and Cloudflare settings are managed separately.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
