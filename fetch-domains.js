#!/usr/bin/env node
// fetch-domains.js — fetches new domains from external sources and merges into index.html.
// Run: node fetch-domains.js [--dry-run]
// Used by: .github/workflows/update-lists.yml (runs before generate-lists.js)

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const INDEX_PATH = path.join(__dirname, 'index.html');

// External sources — each maps to a category id in the CATS array.
// maxNew caps how many new domains are added per source per run to prevent flooding.
const SOURCES = [
  {
    cat: 'tracking',
    name: "Peter Lowe's Ad & Tracking Server List",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext',
    parse: lines => lines
      .map(l => l.trim().toLowerCase())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('!')),
    maxNew: 200,
  },
  {
    cat: 'malware',
    name: 'URLhaus Malware Host List (abuse.ch)',
    url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
    // Format: "127.0.0.1 malicious-domain.com"
    parse: lines => lines
      .filter(l => /^127\.0\.0\.1 /.test(l))
      .map(l => l.replace(/^127\.0\.0\.1\s+/, '').trim().toLowerCase()),
    maxNew: 200,
  },
];

// RFC-compliant domain validation — rejects IPs, wildcards, local names
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const BLOCKED_TLDS = new Set(['localhost', 'local', 'internal', 'example', 'test', 'invalid']);

function isValidDomain(d) {
  if (!d || d.length > 253) return false;
  if (!DOMAIN_RE.test(d)) return false;
  const tld = d.split('.').pop();
  if (BLOCKED_TLDS.has(tld)) return false;
  // Reject plain IPs
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(d)) return false;
  return true;
}

function fetchUrl(urlStr, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(urlStr, { timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchUrl(res.headers.location, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${urlStr}`)); });
  });
}

function extractCats(html) {
  const m = html.match(/const CATS=(\[[\s\S]*?\]);/);
  if (!m) throw new Error('Could not find CATS array in index.html');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

function getCatDomains(html, catId) {
  const m = html.match(new RegExp(`\\{id:'${catId}'.*?domains:\\[([^\\]]*)\\]`));
  if (!m) return null;
  return m[1].split(',').map(d => d.replace(/'/g, '').trim()).filter(Boolean);
}

function updateCatDomains(html, catId, domains) {
  const domainStr = domains.map(d => `'${d}'`).join(',');
  const updated = html.replace(
    new RegExp(`(\\{id:'${catId}'.*?domains:\\[)[^\\]]*(\\])`),
    `$1${domainStr}$2`
  );
  if (updated === html) throw new Error(`Could not update domains for category '${catId}'`);
  return updated;
}

async function main() {
  console.log(`fetch-domains.js${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  const CATS = extractCats(html);

  // Global dedup set — new domains must not exist in ANY category
  const allExisting = new Set(CATS.flatMap(c => c.domains.map(d => d.toLowerCase())));
  console.log(`Existing domains across all categories: ${allExisting.size}`);

  // Collect per-category additions so we can do one merged write per category
  const additions = {}; // catId -> string[]

  for (const source of SOURCES) {
    console.log(`\nSource: ${source.name}`);
    let body;
    try {
      body = await fetchUrl(source.url);
    } catch (err) {
      console.error(`  SKIP — ${err.message}`);
      continue;
    }

    const lines = body.split('\n');
    const candidates = source.parse(lines).filter(isValidDomain);
    console.log(`  Parsed ${candidates.length} valid domains`);

    const newForSource = candidates.filter(d => !allExisting.has(d));
    const toAdd = newForSource.slice(0, source.maxNew);
    console.log(`  New (not yet in any category): ${newForSource.length} → adding ${toAdd.length}`);

    if (toAdd.length === 0) continue;

    if (!additions[source.cat]) additions[source.cat] = [];
    additions[source.cat].push(...toAdd);
    // Register in global set so subsequent sources don't re-add the same domain
    toAdd.forEach(d => allExisting.add(d));
  }

  const totalNew = Object.values(additions).reduce((s, arr) => s + arr.length, 0);

  if (totalNew === 0) {
    console.log('\nNo new domains found — nothing to update.');
    return;
  }

  console.log(`\nSummary: ${totalNew} new domains across ${Object.keys(additions).length} categories`);

  if (DRY_RUN) {
    for (const [catId, domains] of Object.entries(additions)) {
      console.log(`  ${catId}: +${domains.length} (sample: ${domains.slice(0, 5).join(', ')})`);
    }
    console.log('\n[DRY RUN] index.html not modified.');
    return;
  }

  for (const [catId, newDomains] of Object.entries(additions)) {
    const current = getCatDomains(html, catId);
    if (current === null) {
      console.error(`  WARNING: category '${catId}' not found — skipping`);
      continue;
    }
    const merged = [...new Set([...current, ...newDomains])].sort();
    html = updateCatDomains(html, catId, merged);
    console.log(`  Updated '${catId}': ${current.length} → ${merged.length} domains (+${merged.length - current.length})`);
  }

  fs.writeFileSync(INDEX_PATH, html);
  console.log('\nindex.html updated successfully.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
