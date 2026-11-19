#!/usr/bin/env node
// Generates pre-built blocklist files from index.html domain data.
// Run: node generate-lists.js
// Used by: .github/workflows/update-lists.yml

const fs = require('fs');
const path = require('path');

// Extract CATS array from index.html
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const match = html.match(/const CATS=(\[[\s\S]*?\]);/);
if (!match) { console.error('Could not find CATS array in index.html'); process.exit(1); }

// eslint-disable-next-line no-eval
const CATS = eval(match[1]);

const allDomains = [...new Set(CATS.flatMap(c => c.domains))].sort();
const date = new Date().toISOString().split('T')[0];

// The categories the weekly update fills from third-party lists. Their terms are
// in the README (## License); subscribers never see it, so each header says it.
const AUTO = new Set(require('./fetch-domains.js').SOURCES.map(s => s.cat));
const LICENSE_URL = 'https://github.com/DanielEnki420/dns-blocklist-builder#license';
const autoIds = CATS.filter(c => AUTO.has(c.id)).map(c => c.id);
const autoNames = autoIds.length > 1 ? `${autoIds.slice(0, -1).join(', ')} and ${autoIds.at(-1)}` : autoIds.join('');
const license = cat => !cat
  ? `License: MIT for the hand-curated categories. The categories ${autoNames} come from third-party lists with their own terms: ${LICENSE_URL}`
  : AUTO.has(cat.id)
    ? `License: not MIT. These domains come from third-party lists with their own terms: ${LICENSE_URL}`
    : `License: MIT, see ${LICENSE_URL}`;

// Zone files (RPZ) only know ";" comments; a "#" line there is a broken record.
const comment = (c, lines) => lines.map(l => l === '' ? '' : `${c} ${l}`).join('\n');

const header = (fmt, c) => comment(c, [
  '============================================================',
  `DNS Blocklist Builder – All Categories`,
  `Format: ${fmt}`,
  `Generated: ${date}`,
  `Categories: ${CATS.length}`,
  `Domains: ${allDomains.length}`,
  license(null),
  `Source: https://github.com/DanielEnki420/dns-blocklist-builder`,
  `Issues: https://github.com/DanielEnki420/dns-blocklist-builder/issues`,
  '============================================================',
  ''
]);

// RPZ is a zone file. BIND and Unbound load it only with SOA and NS, and take its
// name from the zone the user configures in named.conf: so the rules are relative
// names (no trailing dot, no $ORIGIN), with "*." for the subdomains, as in the
// BIND manual. Refresh is one day (the list changes weekly). The serial is the
// Unix time of the last change of the rules; it stays when they stay.
const RPZ_ZONE = serial => [
  '$TTL 3600',
  `@ IN SOA localhost. hostmaster.localhost. ${serial} 86400 900 2592000 7200`,
  '@ IN NS localhost.',
  ''
].join('\n');
const rpzRules = text => text.split('\n').filter(l => l && !/^[;$@]/.test(l)).join('\n');
function rpzSerial(file, rules) {
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const prev = Number((old.match(/^@ IN SOA \S+ \S+ (\d+) /m) || [])[1] || 0);
  if (prev && rpzRules(old) === rules) return prev;
  return Math.max(prev + 1, Math.floor(Date.now() / 1000));
}
const zoneFor = (file, zone, body) => zone ? RPZ_ZONE(rpzSerial(file, rpzRules(body))) : '';

const listsDir = path.join(__dirname, 'lists');
if (!fs.existsSync(listsDir)) fs.mkdirSync(listsDir);

const files = {
  'blocklist-all.hosts.txt':    { fmt: 'hosts (/etc/hosts)',  fn: d => `0.0.0.0 ${d}` },
  'blocklist-all.pihole.txt':   { fmt: 'Pi-hole adlist',      fn: d => d },
  'blocklist-all.dnsmasq.conf': { fmt: 'dnsmasq',             fn: d => `address=/${d}/0.0.0.0` },
  'blocklist-all.adguard.txt':  { fmt: 'AdGuard Home',        fn: d => `||${d}^` },
  'blocklist-all.unbound.conf': { fmt: 'Unbound',             fn: d => `local-zone: "${d}." static` },
  'blocklist-all.rpz.txt':      { fmt: 'RPZ (BIND9)',         fn: d => `${d} CNAME .\n*.${d} CNAME .`, c: ';', zone: true },
};

for (const [filename, { fmt, fn, c = '#', zone }] of Object.entries(files)) {
  const target = path.join(listsDir, filename);
  const body = allDomains.map(fn).join('\n');
  fs.writeFileSync(target, header(fmt, c) + zoneFor(target, zone, body) + body + '\n');
  console.log(`✓ ${filename} (${allDomains.length} domains)`);
}

console.log(`\nDone: ${allDomains.length} domains, ${CATS.length} categories, ${Object.keys(files).length} formats`);

// ── Per-category lists ────────────────────────────────────────────────────────
const byCatDir = path.join(listsDir, 'by-category');
if (!fs.existsSync(byCatDir)) fs.mkdirSync(byCatDir);

const catHeader = (cat, fmt, c) => comment(c, [
  '============================================================',
  `DNS Blocklist Builder – ${cat.name.en}`,
  `Category: ${cat.id}`,
  `Format: ${fmt}`,
  `Generated: ${date}`,
  `Domains: ${cat.domains.length}`,
  license(cat),
  `Source: https://github.com/DanielEnki420/dns-blocklist-builder`,
  '============================================================',
  ''
]);

let fileCount = 0;
for (const cat of CATS) {
  const domains = [...new Set(cat.domains)].sort();
  for (const [allFile, { fmt, fn, c = '#', zone }] of Object.entries(files)) {
    // e.g. 'blocklist-all.pihole.txt' → 'tracking.pihole.txt'
    const ext      = allFile.replace('blocklist-all.', '');
    const filename = `${cat.id}.${ext}`;
    const target = path.join(byCatDir, filename);
    const body = domains.map(fn).join('\n');
    fs.writeFileSync(target, catHeader(cat, fmt, c) + zoneFor(target, zone, body) + body + '\n');
    fileCount++;
  }
}
console.log(`✓ by-category/ (${CATS.length} cats × 6 formats = ${fileCount} files)`);
