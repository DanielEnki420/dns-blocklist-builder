# 🛡️ DNS Blocklist Builder

> Generate DNS blocklists to block disinformation, propaganda and conspiracy websites.
> No tracking. No dependencies. Works offline.

**Live:** https://danielenki420.github.io/dns-blocklist-builder/

---

## Features

- **8 categories** – Russian propaganda, Epoch Times/Falun Gong, Far-right DACH, Far-right International, Conspiracy theories, Anti-vax, Chinese state media, Climate denial
- **6 formats** – dnsmasq, hosts file, Pi-hole, AdGuard Home, Unbound, RPZ Zone
- **6 languages** – DE, EN, IT, ES, FR, PT
- **250+ domains** curated and validated
- **Zero dependencies** – pure HTML/CSS/JS, works offline
- **Open Source** – MIT License, contributions welcome

## Usage

### Option A: Use online
Go to https://danielenki420.github.io/dns-blocklist-builder/

### Option B: Download and run locally
```bash
git clone https://github.com/DanielEnki420/dns-blocklist-builder
# Open index.html in your browser – no server needed
```

## Raspberry Pi 5 Quickstart

One command installs everything: clones the repo, generates all blocklist formats, configures Pi-hole, and sets up a weekly auto-update.

```bash
curl -fsSL https://raw.githubusercontent.com/DanielEnki420/dns-blocklist-builder/main/setup-pi5.sh | sudo bash
```

**What it does:**
1. Installs Node.js 20 LTS and git (if needed)
2. Clones the repo to `/opt/dns-blocklist-builder`
3. Generates all 6 blocklist formats locally
4. Adds the blocklist to Pi-hole's gravity database and updates gravity
5. Installs a weekly cron job (`/etc/cron.d/dns-blocklist-builder`) for automatic updates

**Prerequisites:** Raspberry Pi OS (or any Debian/Ubuntu system), Pi-hole already installed.

**Options** (set as env vars before piping to bash):

| Variable | Default | Description |
|---|---|---|
| `INSTALL_DIR` | `/opt/dns-blocklist-builder` | Where to clone the repo |
| `CRON_SCHEDULE` | `0 3 * * 1` | Cron schedule for auto-updates |
| `SKIP_PIHOLE` | `0` | Set to `1` to skip Pi-hole integration |
| `SKIP_CRON` | `0` | Set to `1` to skip cron job installation |
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | Telegram bot token for update notifications |
| `TELEGRAM_CHAT_ID` | _(unset)_ | Telegram chat/user ID |

After each weekly update you get a Telegram message like:
```
🛡 Blocklist updated
➕ +8 domains added
📊 Total: 412 domains
📅 2026-06-09 03:00 UTC
✅ Pi-hole gravity refreshed
```

Example — with Telegram notifications:
```bash
curl -fsSL .../setup-pi5.sh | sudo TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=456789 bash
```

Update manually at any time:
```bash
sudo /opt/dns-blocklist-builder/update-pi5.sh
```

---

## Install on your router

### Xiaomi / OpenWrt (dnsmasq)
```bash
# Copy the downloaded blocklist.conf to your router
scp blocklist.conf root@192.168.31.1:/etc/dnsmasq.d/
# Restart dnsmasq
ssh root@192.168.31.1 "/etc/init.d/dnsmasq restart"
```

### Pi-hole
1. Download in Pi-hole format
2. Go to Pi-hole Admin → Group Management → Adlists
3. Add the URL or paste the domains

### AdGuard Home
1. Download in AdGuard format  
2. Go to AdGuard → Filters → DNS blocklists → Add blocklist

### /etc/hosts (any system)
```bash
# Append to your hosts file
sudo cat blocklist.txt >> /etc/hosts
```

## Categories

| Category | Domains | Description |
|----------|---------|-------------|
| 🇷🇺 Russian Propaganda | 40 | RT, Sputnik, TASS, Voice of Europe |
| 📰 Epoch Times / Falun Gong | 29 | NTD, Epoch Times (all languages), Minghui |
| 🇩🇪 Far-right DACH | 37 | Compact, Junge Freiheit, PI-News, AUF1 |
| 🌍 Far-right International | 33 | InfoWars, Breitbart, Daily Stormer |
| 🌀 Conspiracy Theories | 31 | NaturalNews, Rense, BeforeItsNews |
| 💉 Anti-Vax / Medical Disinfo | 30 | Impfkritik, Mercola, CHD, NVIC |
| 🇨🇳 Chinese State Media | 21 | CGTN, Xinhua, China Daily, Global Times |
| 🌡️ Climate Denial | 23 | EIKE, Heartland, GWPF, Watts Up |

## Suggest a domain or category

Found a missing domain? → [Open a GitHub Issue](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=domain_suggestion.md)

Want a new category? → [Open a GitHub Issue](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=category_suggestion.md)

## Contributing

1. Fork this repo
2. Edit `index.html` – the domain lists are in the `CATS` array in the `<script>` section
3. Make sure domains are valid (no spaces, correct TLD)
4. Open a Pull Request

## Note on editorial choices

This tool reflects a specific editorial stance: blocking sites that systematically spread disinformation, state propaganda, or scientifically discredited content. It is not intended to block all conservative or alternative media – only sources with a demonstrated history of deliberate disinformation.

If you disagree with a categorization, please open an Issue to discuss.

## License

MIT © [Daniel Enki](https://github.com/DanielEnki420)
