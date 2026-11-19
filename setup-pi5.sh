#!/usr/bin/env bash
# setup-pi5.sh — Install dns-blocklist-builder on Raspberry Pi 5 (or any Debian-based system)
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/DanielEnki420/dns-blocklist-builder/main/setup-pi5.sh | sudo bash
#
# Env-var overrides:
#   INSTALL_DIR=/opt/dns-blocklist-builder   Clone location (default shown)
#   CRON_SCHEDULE="0 3 * * 1"               Weekly update schedule (default: Mon 03:00 UTC)
#   SKIP_PIHOLE=1                            Skip Pi-hole gravity integration
#   SKIP_CRON=1                              Skip cron job installation
#   PIHOLE_CONTAINER=pihole                  Name of a Pi-hole Docker container (default shown)
#   TELEGRAM_BOT_TOKEN=<token>               Telegram bot token for update notifications
#   TELEGRAM_CHAT_ID=<id>                    Telegram chat/user ID

set -euo pipefail

REPO_URL="https://github.com/DanielEnki420/dns-blocklist-builder.git"
INSTALL_DIR="${INSTALL_DIR:-/opt/dns-blocklist-builder}"
CRON_SCHEDULE="${CRON_SCHEDULE:-0 3 * * 1}"
SKIP_PIHOLE="${SKIP_PIHOLE:-0}"
SKIP_CRON="${SKIP_CRON:-0}"
PIHOLE_CONTAINER="${PIHOLE_CONTAINER:-pihole}"
# A Pi-hole in Docker cannot read $INSTALL_DIR, so it gets the published list by URL
LIST_URL="https://raw.githubusercontent.com/DanielEnki420/dns-blocklist-builder/main/lists/blocklist-all.pihole.txt"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
LOG_FILE="/var/log/dns-blocklist-update.log"

# ── Terminal colours (suppressed when not a TTY) ──────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

info()    { printf "${CYAN}➤${NC}  %s\n" "$*"; }
ok()      { printf "${GREEN}✓${NC}  %s\n" "$*"; }
warn()    { printf "${YELLOW}⚠${NC}  %s\n" "$*"; }
die()     { printf "${RED}✗  %s${NC}\n" "$*" >&2; exit 1; }
header()  { printf "\n${BOLD}%s${NC}\n$(printf '─%.0s' $(seq 1 60))\n" "$*"; }

# ── Preflight ─────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0"
[[ $PIHOLE_CONTAINER =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "PIHOLE_CONTAINER is not a container name: $PIHOLE_CONTAINER"
[[ $SKIP_PIHOLE =~ ^[01]$ ]] || die "SKIP_PIHOLE must be 0 or 1, not: $SKIP_PIHOLE"

if ! grep -qiE 'debian|ubuntu|raspbian' /etc/os-release 2>/dev/null; then
  warn "This script targets Debian/Ubuntu/Raspberry Pi OS. Proceeding anyway…"
fi

# ── Dependency installation ───────────────────────────────────────────────────
install_git() {
  if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}')"
    return
  fi
  info "Installing git…"
  apt-get install -y -qq git
  ok "git installed"
}

# Node 20 reached end of life on 30 April 2026. An installed Node 22 (supported
# until April 2027) or newer is kept; anything older is replaced by Node 24 LTS.
install_node() {
  local min_version=22 install_version=24
  if command -v node &>/dev/null; then
    local ver
    ver=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$min_version" ]; then
      ok "Node.js $(node --version)"
      return
    fi
    warn "Node.js $(node --version) < v${min_version} — upgrading to v${install_version} via NodeSource…"
  else
    info "Installing Node.js ${install_version} LTS via NodeSource…"
  fi
  curl -fsSL "https://deb.nodesource.com/setup_${install_version}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs
  ok "Node.js $(node --version) installed"
}

install_sqlite3() {
  if command -v sqlite3 &>/dev/null; then
    ok "sqlite3 $(sqlite3 --version | awk '{print $1}')"
    return
  fi
  info "Installing sqlite3 (for Pi-hole gravity.db)…"
  apt-get install -y -qq sqlite3
  ok "sqlite3 installed"
}

# ── Repository ────────────────────────────────────────────────────────────────
setup_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating repo at $INSTALL_DIR…"
    # lists/ is regenerated locally and always differs from upstream (at least
    # the "# Generated:" date); without this the pull refuses to overwrite it.
    git -C "$INSTALL_DIR" checkout --quiet -- lists/
    git -C "$INSTALL_DIR" pull --ff-only --quiet
    ok "Repo updated"
  else
    info "Cloning to $INSTALL_DIR…"
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
    ok "Repo cloned"
  fi
}

# ── Blocklist generation ──────────────────────────────────────────────────────
generate_lists() {
  info "Generating blocklist files…"
  node "$INSTALL_DIR/generate-lists.js"
  local count
  count=$(grep -c '^[^#[:space:]]' "$INSTALL_DIR/lists/blocklist-all.pihole.txt" 2>/dev/null || echo "?")
  ok "$count domains written to $INSTALL_DIR/lists/"
}

# ── Pi-hole integration ───────────────────────────────────────────────────────
# pihole_container_running - is the Docker container $PIHOLE_CONTAINER up?
# Not "docker ps | grep -q": under pipefail, grep leaving early can fail the pipe.
pihole_container_running() {
  local names
  command -v docker &>/dev/null || return 1
  names=$(docker ps --format '{{.Names}}' 2>/dev/null) || return 1
  grep -qx "$PIHOLE_CONTAINER" <<<"$names"
}

configure_pihole() {
  if [ "$SKIP_PIHOLE" = "1" ]; then
    warn "Pi-hole integration skipped (SKIP_PIHOLE=1)"
    return
  fi

  local comment="dns-blocklist-builder"
  # OR IGNORE: the same address may already be there under another comment
  local add_sql="INSERT OR IGNORE INTO adlist (address, enabled, comment)"

  if command -v pihole &>/dev/null; then
    local gravity_db="/etc/pihole/gravity.db"
    local list_path="$INSTALL_DIR/lists/blocklist-all.pihole.txt"
    if [ ! -f "$gravity_db" ]; then
      die "gravity.db not found at $gravity_db — is Pi-hole fully installed?"
    fi
    info "Adding adlist to Pi-hole gravity.db…"
    sqlite3 "$gravity_db" "DELETE FROM adlist WHERE comment='$comment';"
    sqlite3 "$gravity_db" "$add_sql VALUES ('file://$list_path', 1, '$comment');"
    info "Updating Pi-hole gravity (this may take a moment)…"
    pihole -g
    ok "Pi-hole gravity updated"
  elif pihole_container_running; then
    info "Pi-hole runs in the Docker container '$PIHOLE_CONTAINER' — adding the list by URL…"
    # The Pi-hole image has no sqlite3 binary; pihole-FTL has one built in
    docker exec "$PIHOLE_CONTAINER" pihole-FTL sqlite3 /etc/pihole/gravity.db \
      "DELETE FROM adlist WHERE comment='$comment'; $add_sql VALUES ('$LIST_URL', 1, '$comment');"
    info "Updating Pi-hole gravity (this may take a moment)…"
    docker exec "$PIHOLE_CONTAINER" pihole -g
    ok "Pi-hole gravity updated (container $PIHOLE_CONTAINER)"
  else
    warn "Pi-hole not found (not installed, no running container '$PIHOLE_CONTAINER') — skipping gravity integration"
    info  "Install Pi-hole first: curl -sSL https://install.pi-hole.net | bash"
  fi
}

# ── Telegram notifications ────────────────────────────────────────────────────
configure_telegram() {
  if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
    warn "Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable"
    return
  fi

  local cfg="$INSTALL_DIR/.telegram"
  printf 'BOT_TOKEN=%s\nCHAT_ID=%s\n' "$TELEGRAM_BOT_TOKEN" "$TELEGRAM_CHAT_ID" > "$cfg"
  chmod 600 "$cfg"
  ok "Telegram credentials saved to $cfg"

  local domain_count
  domain_count=$(grep -c '^[^#[:space:]]' "$INSTALL_DIR/lists/blocklist-all.pihole.txt" 2>/dev/null || echo "?")

  info "Sending test notification…"
  curl -fsSL -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=🛡 <b>DNS Blocklist Builder</b> installed on Raspberry Pi 5
✅ Telegram notifications active
📊 ${domain_count} domains blocked
📅 $(date -u '+%Y-%m-%d %H:%M') UTC" \
    --data-urlencode "parse_mode=HTML" \
    -o /dev/null \
    && ok "Test notification sent" \
    || warn "Test notification failed — check BOT_TOKEN and CHAT_ID"
}

# ── Auto-update script ────────────────────────────────────────────────────────
write_update_script() {
  local script="$INSTALL_DIR/update-pi5.sh"

  # Single-quoted heredoc: no variable expansion — everything is literal in the
  # generated script (variables are resolved at runtime, not at write time).
  cat > "$script" << 'UPDATESCRIPT'
#!/usr/bin/env bash
# Auto-generated by setup-pi5.sh — updates blocklists and refreshes Pi-hole gravity
set -Eeuo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
TELEGRAM_CFG="$INSTALL_DIR/.telegram"
PIHOLE_LIST="$INSTALL_DIR/lists/blocklist-all.pihole.txt"
LOG_FILE=/var/log/dns-blocklist-update.log
# Filled in by setup-pi5.sh with the values of the setup run
PIHOLE_CONTAINER="${PIHOLE_CONTAINER:-@PIHOLE_CONTAINER@}"
SKIP_PIHOLE="${SKIP_PIHOLE:-@SKIP_PIHOLE@}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# ── Telegram ──────────────────────────────────────────────────────────────────
send_telegram() {
  local msg="$1"
  [ -f "$TELEGRAM_CFG" ] || return 0
  # shellcheck source=/dev/null
  source "$TELEGRAM_CFG"
  [ -n "${BOT_TOKEN:-}" ] && [ -n "${CHAT_ID:-}" ] || return 0
  curl -fsSL -X POST \
    "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    --data-urlencode "parse_mode=HTML" \
    -o /dev/null || true
}

count_domains() {
  # grep -c prints 0 and fails on no match; "|| echo 0" would then print 0 twice
  local n
  n=$(grep -c '^[^#[:space:]]' "$PIHOLE_LIST" 2>/dev/null || true)
  echo "${n:-0}"
}

# pihole_container_running - is the Docker container $PIHOLE_CONTAINER up?
# Not "docker ps | grep -q": under pipefail, grep leaving early can fail the pipe.
pihole_container_running() {
  local names
  command -v docker &>/dev/null || return 1
  names=$(docker ps --format '{{.Names}}' 2>/dev/null) || return 1
  grep -qx "$PIHOLE_CONTAINER" <<<"$names"
}

# Any failing command ends this script (set -e). Say so instead of going quiet:
# a refused "git pull" once stopped every weekly update without a word.
on_error() {
  local rc=$? line=$1
  trap - ERR
  log "FAILED: exit $rc at line $line"
  send_telegram "🔴 <b>Blocklist update failed</b>
Exit ${rc} at line ${line} of update-pi5.sh, details in ${LOG_FILE}
📅 $(date -u '+%Y-%m-%d %H:%M') UTC"
  exit "$rc"
}
trap 'on_error $LINENO' ERR

# ── Update ────────────────────────────────────────────────────────────────────
BEFORE=$(count_domains)
log "Starting update (current: $BEFORE domains)"

# lists/ is regenerated below and always differs from upstream (at least the
# "# Generated:" date): put it back first, or the pull refuses to run.
git -C "$INSTALL_DIR" checkout --quiet -- lists/
git -C "$INSTALL_DIR" pull --ff-only --quiet
node "$INSTALL_DIR/generate-lists.js"

AFTER=$(count_domains)
DELTA=$((AFTER - BEFORE))
PIHOLE_LINE=""

if [ "$SKIP_PIHOLE" = 1 ]; then
  :
elif command -v pihole &>/dev/null && [ -f /etc/pihole/gravity.db ]; then
  pihole -g
  PIHOLE_LINE=$'\n✅ Pi-hole gravity refreshed'
  log "Pi-hole gravity updated"
elif pihole_container_running; then
  docker exec "$PIHOLE_CONTAINER" pihole -g
  PIHOLE_LINE=$'\n✅ Pi-hole gravity refreshed'
  log "Pi-hole gravity updated (container $PIHOLE_CONTAINER)"
else
  PIHOLE_LINE=$'\n⚠️ No Pi-hole found, gravity not refreshed'
  log "No Pi-hole found (host or container $PIHOLE_CONTAINER), gravity not refreshed"
fi

log "Done — $AFTER domains total (Δ $DELTA)"

# ── Notification ──────────────────────────────────────────────────────────────
if [ "$DELTA" -gt 0 ]; then
  DELTA_STR="➕ +${DELTA} domains added"
elif [ "$DELTA" -lt 0 ]; then
  DELTA_STR="➖ ${DELTA#-} domains removed"
else
  DELTA_STR="↔️  No domain changes"
fi

send_telegram "🛡 <b>Blocklist updated</b>
${DELTA_STR}
📊 Total: ${AFTER} domains
📅 $(date -u '+%Y-%m-%d %H:%M') UTC${PIHOLE_LINE}"
UPDATESCRIPT

  # Cron starts the script without this environment: write the values in
  local body
  body=$(<"$script")
  body=${body//@PIHOLE_CONTAINER@/$PIHOLE_CONTAINER}
  body=${body//@SKIP_PIHOLE@/$SKIP_PIHOLE}
  printf '%s\n' "$body" > "$script"
  chmod +x "$script"
  ok "Update script: $script"
}

install_bot_service() {
  local service_file="/etc/systemd/system/dns-blocklist-bot.service"
  # Without .telegram the bot exits at once, and Restart=always would start it
  # again every 10 seconds, forever
  if [ ! -f "$INSTALL_DIR/.telegram" ]; then
    warn "Telegram bot service skipped (Telegram not configured)"
    return
  fi

  cat > "$service_file" << UNIT
[Unit]
Description=DNS Blocklist Builder Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node $INSTALL_DIR/bot-listener.js
Restart=always
RestartSec=10
User=root
WorkingDirectory=$INSTALL_DIR
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now dns-blocklist-bot
  ok "Bot service installed and started (dns-blocklist-bot)"
}

setup_cron() {
  if [ "$SKIP_CRON" = "1" ]; then
    warn "Cron setup skipped (SKIP_CRON=1)"
    return
  fi

  write_update_script

  local cron_line="$CRON_SCHEDULE root $INSTALL_DIR/update-pi5.sh >> $LOG_FILE 2>&1"
  local cron_file="/etc/cron.d/dns-blocklist-builder"

  printf "# dns-blocklist-builder auto-update\n%s\n" "$cron_line" > "$cron_file"
  chmod 644 "$cron_file"
  ok "Cron job installed: $cron_file ($CRON_SCHEDULE)"
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  local domain_count
  domain_count=$(grep -c '^[^#[:space:]]' "$INSTALL_DIR/lists/blocklist-all.pihole.txt" 2>/dev/null || echo "?")
  local telegram_status="disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"
  [ -f "$INSTALL_DIR/.telegram" ] && telegram_status="enabled ✓"

  header "Setup complete"
  printf "  %-24s %s\n" "Install dir:"       "$INSTALL_DIR"
  printf "  %-24s %s\n" "Domains blocked:"   "$domain_count"
  printf "  %-24s %s\n" "Formats:"           "Pi-hole, dnsmasq, AdGuard, Unbound, hosts, RPZ"
  printf "  %-24s %s\n" "Telegram alerts:"   "$telegram_status"
  if [ "$SKIP_CRON" != "1" ]; then
    printf "  %-24s %s\n" "Auto-update:"     "cron ($CRON_SCHEDULE) → $LOG_FILE"
  fi
  printf "\n"
  info "Update manually:   sudo $INSTALL_DIR/update-pi5.sh"
  info "Blocklist files:   $INSTALL_DIR/lists/"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  header "DNS Blocklist Builder — Raspberry Pi 5 Setup"

  header "1/7  System dependencies"
  apt-get update -qq
  install_git
  install_node
  install_sqlite3

  header "2/7  Repository"
  setup_repo

  header "3/7  Generate blocklists"
  generate_lists

  header "4/7  Pi-hole integration"
  configure_pihole

  header "5/7  Telegram notifications"
  configure_telegram

  header "6/7  Auto-update cron job"
  setup_cron

  header "7/7  Telegram bot service"
  install_bot_service

  print_summary
}

main "$@"
