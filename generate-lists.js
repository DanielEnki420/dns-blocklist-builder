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

const listsDir = path.join(__dirname, 'lists');
if (!fs.existsSync(listsDir)) fs.mkdirSync(listsDir);

const files = {
  'blocklist-all.hosts.txt':    { fmt: 'hosts (/etc/hosts)',  fn: d => `0.0.0.0 ${d}` },
  'blocklist-all.pihole.txt':   { fmt: 'Pi-hole adlist',      fn: d => d },
  'blocklist-all.dnsmasq.conf': { fmt: 'dnsmasq',             fn: d => `address=/${d}/0.0.0.0` },
  'blocklist-all.adguard.txt':  { fmt: 'AdGuard Home',        fn: d => `||${d}^` },
  'blocklist-all.unbound.conf': { fmt: 'Unbound',             fn: d => `local-zone: "${d}." static` },
  'blocklist-all.rpz.txt':      { fmt: 'RPZ (BIND9)',         fn: d => `${d}. CNAME .`, c: ';' },
};

for (const [filename, { fmt, fn, c = '#' }] of Object.entries(files)) {
  const content = header(fmt, c) + allDomains.map(fn).join('\n') + '\n';
  fs.writeFileSync(path.join(listsDir, filename), content);
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
  for (const [allFile, { fmt, fn, c = '#' }] of Object.entries(files)) {
    // e.g. 'blocklist-all.pihole.txt' → 'tracking.pihole.txt'
    const ext      = allFile.replace('blocklist-all.', '');
    const filename = `${cat.id}.${ext}`;
    fs.writeFileSync(path.join(byCatDir, filename), catHeader(cat, fmt, c) + domains.map(fn).join('\n') + '\n');
    fileCount++;
  }
}
console.log(`✓ by-category/ (${CATS.length} cats × 6 formats = ${fileCount} files)`);
