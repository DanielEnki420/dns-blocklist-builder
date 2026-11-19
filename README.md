# 🛡️ DNS Blocklist Builder

> Generate DNS blocklists against disinformation, state propaganda and conspiracy sites,
> and against trackers, scams and malware.
> No tracking by default (anonymous usage stats only if you switch them on).
> No dependencies. Works offline.

**Live:** https://danielenki420.github.io/dns-blocklist-builder/

---

## Features

- **11 categories** – eight curated by hand (Russian propaganda, Epoch Times/Falun Gong, Far-right DACH, Far-right International, Conspiracy theories, Anti-vax, Chinese state media, Climate denial) and three filled from public lists (Ad tracking & data brokers, Investment fraud & crypto scams, Malware & adware)
- **6 formats** – dnsmasq, hosts file, Pi-hole, AdGuard Home, Unbound, RPZ Zone
- **6 languages** – DE, EN, IT, ES, FR, PT
- **About 1,000 domains**, updated every week from the public lists; once a month, domains that no longer resolve are dropped
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
➕ +100 domains added
📊 Total: 1003 domains
📅 2026-11-16 03:00 UTC
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
# Copy the downloaded file to your router (use your router's address)
scp blocklist_*.conf root@ROUTER_IP:/etc/dnsmasq.d/
# Restart dnsmasq
ssh root@ROUTER_IP "/etc/init.d/dnsmasq restart"
```

### Pi-hole
Add this URL as an adlist (Pi-hole 6: Lists; Pi-hole 5: Group Management → Adlists),
then update gravity. It always
serves the latest weekly list:
```
https://raw.githubusercontent.com/DanielEnki420/dns-blocklist-builder/main/lists/blocklist-all.pihole.txt
```
Only some categories? Use the files in [`lists/by-category/`](lists/by-category/), or pick
them in the tool and download the result.

### AdGuard Home
Go to Filters → DNS blocklists → Add blocklist → Add a custom list, with this URL:
```
https://raw.githubusercontent.com/DanielEnki420/dns-blocklist-builder/main/lists/blocklist-all.adguard.txt
```

### /etc/hosts (any system)
```bash
# Append to your hosts file ("sudo cat … >> /etc/hosts" fails: the redirect runs without sudo)
cat blocklist_*.txt | sudo tee -a /etc/hosts >/dev/null
```

## Categories

Counts as of 16 November 2026. The current number is in the header of every file in
`lists/` (`# Domains: …`).

| Category | Domains | Description |
|----------|---------|-------------|
| 🇷🇺 Russian Propaganda | 49 | RT, Sputnik, TASS, Voice of Europe |
| 📰 Epoch Times / Falun Gong | 38 | NTD, Epoch Times (all languages), Minghui |
| 🇩🇪 Far-right DACH | 48 | Compact, Junge Freiheit, PI-News, AUF1 |
| 🌍 Far-right International | 48 | InfoWars, Breitbart, Daily Stormer |
| 🌀 Conspiracy Theories | 36 | NaturalNews, Rense, BeforeItsNews |
| 💉 Anti-Vax / Medical Disinfo | 31 | Impfkritik, Mercola, CHD, NVIC |
| 🇨🇳 Chinese State Media | 32 | CGTN, Xinhua, China Daily, Global Times |
| 🌡️ Climate Denial | 26 | EIKE, Heartland, GWPF, Watts Up |
| 📡 Ad Tracking & Data Brokers | 61 | from yoyo.org, Disconnect and Hagezi, weekly |
| 🎣 Investment Fraud & Crypto Scam | 620 | from Phishing Army, up to 100 new per week |
| 🦠 Malware & Adware Distributors | 14 | from URLhaus and Disconnect, weekly |

The eight editorial categories are curated by hand. The last three are filled
automatically: a domain must appear in at least two sources of its category before
it is added (where the category has two or more). On the first Monday of each month
the update also drops domains that no longer resolve.

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
