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
- **More than 1,000 domains**, updated every week from the public lists; once a month, domains that no longer resolve are dropped
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
1. Installs git and Node.js 24 LTS if needed (an installed Node.js 22 or newer is kept)
2. Clones the repo to `/opt/dns-blocklist-builder`
3. Generates all 6 blocklist formats locally
4. Adds the blocklist to Pi-hole and updates gravity: Pi-hole installed on the host gets the
   local file, Pi-hole in a Docker container (named `pihole`, see `PIHOLE_CONTAINER`) gets the
   published list by URL
5. Installs a weekly cron job (`/etc/cron.d/dns-blocklist-builder`) for automatic updates
6. With Telegram set up: a message after every update, and a bot service (`dns-blocklist-bot`)

**Prerequisites:** Raspberry Pi OS (or any Debian/Ubuntu system), Pi-hole already installed
(on the host or in Docker).

**Options** (set as env vars before piping to bash):

| Variable | Default | Description |
|---|---|---|
| `INSTALL_DIR` | `/opt/dns-blocklist-builder` | Where to clone the repo |
| `CRON_SCHEDULE` | `0 3 * * 1` | Cron schedule for auto-updates |
| `SKIP_PIHOLE` | `0` | Set to `1` to skip Pi-hole integration |
| `SKIP_CRON` | `0` | Set to `1` to skip cron job installation |
| `PIHOLE_CONTAINER` | `pihole` | Name of your Pi-hole Docker container |
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

If an update fails, the message says `🔴 Blocklist update failed`, with the exit code and
the line, instead of the update stopping without a word.

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

Counts as of 19 November 2026. The current number is in the header of every file in
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
| 📡 Ad Tracking & Data Brokers | 61 | ads and trackers from yoyo.org that Hagezi Multi Light (or Disconnect) also lists, up to 100 new per week |
| 🎣 Investment Fraud & Crypto Scam | 720 | from Phishing Army, up to 100 new per week |
| 🦠 Malware & Adware Distributors | 14 | URLhaus hosts that are online (via malware-filter), confirmed by Hagezi's threat feeds, up to 300 new per week |

The eight editorial categories are curated by hand. The last three are filled
automatically: a domain must appear in at least two sources of its category before
it is added (where the category has two or more). For tracking the second source is
a filter more than an independent check: Hagezi uses yoyo.org as one of its inputs
and keeps only popular, well-checked domains. A domain the update added leaves again
once its sources have not confirmed it for four weekly runs in a row; a run in which
one of the category's sources failed does not count. Domains added by hand never
expire. [`auto-domains.json`](auto-domains.json) keeps the count. On the first Monday
of each month the update also drops domains that no longer resolve.

If a source fails or suddenly delivers almost nothing, the weekly update still
builds the lists from the others, and the run is marked as failed so it gets fixed.
Until 19 November 2026 this went unnoticed: the Hagezi tracking list had moved
(August 2026), URLhaus ended its free host file (October 2026) and the Disconnect
malware list had shrunk to a single test domain, so tracking and malware got almost
no new domains.

## Suggest a domain or category

Found a missing domain? → [Open a GitHub Issue](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=domain_suggestion.md)

Want a new category? → [Open a GitHub Issue](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=category_suggestion.md)

A legitimate site is blocked? → [Open a GitHub Issue](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=false_positive.md)
titled `[remove] example.com` and say what breaks. In the automatic categories
(tracking, malware, phishing) the domain goes into [`allowlist.txt`](allowlist.txt):
the lists are rebuilt within minutes, and the public sources cannot bring it back.
Domains in the hand-curated categories are removed by hand.

Something does not work? → [Open a GitHub Issue](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=bug_report.md)

## Contributing

1. Fork this repo
2. Edit `index.html` – the domain lists are in the `CATS` array in the `<script>` section
3. Make sure domains are valid (no spaces, correct TLD)
4. Open a Pull Request

Changing `setup-pi5.sh`? Run its tests first (they need git and Node.js, and change
nothing outside a temporary directory):

```bash
bash tests/test-setup-pi5.sh
```

## Note on editorial choices

This tool reflects a specific editorial stance: blocking sites that systematically spread disinformation, state propaganda, or scientifically discredited content. It is not intended to block all conservative or alternative media – only sources with a demonstrated history of deliberate disinformation.

If you disagree with a categorization, please open an Issue to discuss.

## License

The code, the web tool and the eight hand-curated categories: MIT ©
[Daniel Enki](https://github.com/DanielEnki420).

The MIT license does not cover the three automatic categories (tracking, malware,
phishing). They are selected from the public lists below: a domain is included only
if it is in the first source and, for tracking and malware, also in a second source
that serves only as a filter. Single domain names are facts, but the source lists
may be protected as collections. If you redistribute these categories (the files in
`lists/` or the automatic categories in `index.html`), check the terms below. None
of these maintainers endorse this project. Every file in `lists/` says in its header
which license applies to it.

| Source | Category | Terms |
|--------|----------|-------|
| [Peter Lowe's Ad & Tracking List](https://pgl.yoyo.org/adservers/) | tracking | no formal license; the site says "Feel free to combine this list with yours or lists from other sites" and to put the result on the web |
| [Disconnect.me Tracking](https://disconnect.me/) | tracking (filter only) | GPL-3.0, stated in the list |
| [Hagezi Multi Light](https://github.com/hagezi/dns-blocklists) | tracking (filter only) | [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE) |
| [malware-filter (URLhaus)](https://gitlab.com/malware-filter/urlhaus-filter) | malware | [CC0 and MIT](https://gitlab.com/malware-filter/urlhaus-filter#license); the [URLhaus](https://urlhaus.abuse.ch/) data is CC0 |
| [Hagezi Threat Intelligence Feeds (mini)](https://github.com/hagezi/dns-blocklists) | malware (filter only) | [GPL-3.0](https://github.com/hagezi/dns-blocklists/blob/main/LICENSE) |
| [Phishing Army Blocklist](https://phishing.army/) | phishing | no extra restrictions of its own; the terms of its [upstream sources](https://phishing.army/sources/) (PhishTank, OpenPhish, CERT.PL and others) apply, see [usage and licensing](https://phishing.army/license/) |

Checked on 19 November 2026. Terms can change; the linked pages are what counts.
Thanks to everyone who maintains these lists: without them there would be no
automatic categories.
