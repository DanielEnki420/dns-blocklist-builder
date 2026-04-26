#!/usr/bin/env node
'use strict';
// fetch-domains.js — fetches new domains from external sources → index.html
//
// Usage:
//   node fetch-domains.js             fetch new domains
//   node fetch-domains.js --cleanup   also remove domains that no longer resolve via DNS
//   node fetch-domains.js --dry-run   preview changes without writing any files

const https = require('https');
const http  = require('http');
const dns   = require('dns').promises;
const fs    = require('fs');
const path  = require('path');

const DRY_RUN    = process.argv.includes('--dry-run');
const CLEANUP    = process.argv.includes('--cleanup');
const INDEX_PATH = path.join(__dirname, 'index.html');
const CACHE_DIR  = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'source-cache.json');

// Domain must appear in ≥MIN_SOURCES sources within its category before being added.
// Only applied when a category has ≥2 sources; otherwise all valid domains are candidates.
const MIN_SOURCES  = 2;
const DNS_BATCH    = 30; // concurrent DNS lookups during cleanup

// ── Sources ───────────────────────────────────────────────────────────────────
// Each source maps to a category id from the CATS array in index.html.
// maxNew caps how many new domains are added per category per run after filtering.
const SOURCES = [
  {
    cat: 'tracking', maxNew: 300,
    name: "Peter Lowe's Ad & Tracking List",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext',
  },
  {
    cat: 'tracking', maxNew: 300,
    name: 'Disconnect.me Tracking',
    url: 'https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt',
  },
  {
    cat: 'tracking', maxNew: 300,
    name: 'Hagezi Tracking',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/tracking.txt',
  },
  {
    cat: 'malware', maxNew: 300,
    name: 'URLhaus Malware Hosts (abuse.ch)',
    url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
    hostsFormat: true, // "127.0.0.1 domain" lines
  },
  {
    cat: 'malware', maxNew: 300,
    name: 'Disconnect.me Malware',
    url: 'https://s3.amazonaws.com/lists.disconnect.me/simple_malware.txt',
  },
  {
    cat: 'phishing', maxNew: 100,
    name: 'Phishing Army Blocklist',
    url: 'https://phishing.army/download/phishing_army_blocklist.txt',
  },
];

// ── Domain validation ─────────────────────────────────────────────────────────
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const RESERVED  = new Set(['localhost','local','internal','example','test','invalid','onion']);

function isValidDomain(d) {
  if (!d || d.length > 253)                           return false;
  if (!DOMAIN_RE.test(d))                             return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(d))             return false; // IPv4
  if (RESERVED.has(d.split('.').pop()))               return false;
  return true;
}

function parseDomains(text, hostsFormat) {
  return text.split('\n').map(l => {
    l = l.trim().toLowerCase();
    if (hostsFormat) {
      const m = l.match(/^(?:127\.0\.0\.1|0\.0\.0\.0)\s+(\S+)/);
      return m ? m[1] : '';
    }
    return (l.startsWith('#') || l.startsWith('!')) ? '' : l;
  }).filter(isValidDomain);
}

// ── ETag cache ────────────────────────────────────────────────────────────────
// Persists parsed domains + conditional-request headers between runs.
// GitHub Actions caches .cache/ via actions/cache so 304s are effective in CI.

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function httpGet(urlStr, headers = {}, hops = 0) {
  if (hops > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'dns-blocklist-builder/2.0', ...headers },
        timeout: 20000 },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGet(res.headers.location, {}, hops + 1).then(resolve).catch(reject);
        }
        if (res.statusCode === 304) {
          res.resume();
          return resolve({ status: 304, headers: res.headers, body: '' });
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
        }
        const buf = [];
        res.on('data', c => buf.push(c));
        res.on('end',  () => resolve({ status: 200, headers: res.headers,
                                       body: Buffer.concat(buf).toString() }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${urlStr}`)); });
  });
}

async function fetchSource(source, cache) {
  const cached = cache[source.url];
  const condHeaders = {};
  if (cached?.etag)          condHeaders['If-None-Match']     = cached.etag;
  else if (cached?.lm)       condHeaders['If-Modified-Since'] = cached.lm;

  const res = await httpGet(source.url, condHeaders);

  if (res.status === 304 && cached?.domains) {
    process.stdout.write('304 Not Modified → ');
    return cached.domains;
  }

  const domains = parseDomains(res.body, source.hostsFormat);
  cache[source.url] = {
    etag: res.headers['etag']          ?? cached?.etag ?? null,
    lm:   res.headers['last-modified'] ?? cached?.lm   ?? null,
    domains,
  };
  return domains;
}

// ── index.html helpers ────────────────────────────────────────────────────────
function extractCats(html) {
  const m = html.match(/const CATS=(\[[\s\S]*?\]);/);
  if (!m) throw new Error('CATS array not found in index.html');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

function getCatDomains(html, catId) {
  const m = html.match(new RegExp(`\\{id:'${catId}'.*?domains:\\[([^\\]]*)\\]`));
  return m ? m[1].split(',').map(d => d.replace(/'/g, '').trim()).filter(Boolean) : null;
}

function setCatDomains(html, catId, domains) {
  const str = domains.map(d => `'${d}'`).join(',');
  const out = html.replace(
    new RegExp(`(\\{id:'${catId}'.*?domains:\\[)[^\\]]*(\\])`),
    `$1${str}$2`
  );
  if (out === html) throw new Error(`Category '${catId}' not found in index.html`);
  return out;
}

// ── Dead-domain cleanup ───────────────────────────────────────────────────────
async function removeDeadDomains(html, CATS) {
  const allDomains = [...new Set(CATS.flatMap(c => c.domains))];
  console.log(`\nDNS cleanup: checking ${allDomains.length} domains (${DNS_BATCH} parallel)...`);

  const dead = new Set();
  for (let i = 0; i < allDomains.length; i += DNS_BATCH) {
    const batch   = allDomains.slice(i, i + DNS_BATCH);
    const results = await Promise.allSettled(batch.map(d => dns.resolve(d)));
    results.forEach((r, j) => {
      // ENOTFOUND = NXDOMAIN — domain definitively does not exist
      if (r.status === 'rejected' && r.reason.code === 'ENOTFOUND') dead.add(batch[j]);
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  if (dead.size === 0) { console.log('No dead domains found.'); return html; }

  console.log(`Removing ${dead.size} dead domains:`);
  for (const cat of CATS) {
    const gone = cat.domains.filter(d => dead.has(d));
    if (!gone.length) continue;
    html = setCatDomains(html, cat.id, cat.domains.filter(d => !dead.has(d)));
    console.log(`  ${cat.id}: -${gone.length}  (${gone.slice(0, 3).join(', ')}${gone.length > 3 ? '…' : ''})`);
  }
  return html;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`fetch-domains.js${DRY_RUN ? ' [DRY RUN]' : ''}${CLEANUP ? ' [+CLEANUP]' : ''}\n`);

  let html   = fs.readFileSync(INDEX_PATH, 'utf8');
  const CATS = extractCats(html);

  // Global existing-domain set — new domains must not already live in any category
  const allExisting = new Set(CATS.flatMap(c => c.domains.map(d => d.toLowerCase())));
  console.log(`Existing: ${allExisting.size} domains in ${CATS.length} categories\n`);

  // Source count per category (used to decide whether to apply MIN_SOURCES filter)
  const srcCount = {};
  for (const s of SOURCES) srcCount[s.cat] = (srcCount[s.cat] || 0) + 1;

  const cache = loadCache();

  // Collect: catId → Map<domain, Set<sourceName>>
  const seen = {};

  for (const source of SOURCES) {
    process.stdout.write(`Fetching ${source.name}... `);
    let domains;
    try {
      domains = await fetchSource(source, cache);
      console.log(`${domains.length.toLocaleString()} domains`);
    } catch (err) {
      console.log(`SKIP — ${err.message}`);
      continue;
    }

    if (!seen[source.cat]) seen[source.cat] = new Map();
    const catMap = seen[source.cat];
    for (const d of domains) {
      if (allExisting.has(d)) continue;
      if (!catMap.has(d)) catMap.set(d, new Set());
      catMap.get(d).add(source.name);
    }
  }

  saveCache(cache);

  // Filter by min appearances and apply per-category cap
  const additions = {};
  for (const [catId, domainMap] of Object.entries(seen)) {
    const minApp   = srcCount[catId] >= MIN_SOURCES ? MIN_SOURCES : 1;
    const maxNew   = Math.max(...SOURCES.filter(s => s.cat === catId).map(s => s.maxNew));
    const filtered = [...domainMap.entries()]
      .filter(([, srcs]) => srcs.size >= minApp)
      .map(([d]) => d)
      .sort()
      .slice(0, maxNew);
    if (filtered.length) additions[catId] = filtered;
  }

  const totalNew = Object.values(additions).reduce((n, a) => n + a.length, 0);
  console.log(`\nNew domains (≥${MIN_SOURCES}-source confidence filter): ${totalNew}`);
  for (const [catId, domains] of Object.entries(additions))
    console.log(`  ${catId}: +${domains.length}`);

  // Write additions to index.html
  if (!DRY_RUN && totalNew > 0) {
    for (const [catId, newDomains] of Object.entries(additions)) {
      const current = getCatDomains(html, catId);
      if (!current) { console.error(`  WARNING: '${catId}' not found — skipping`); continue; }
      html = setCatDomains(html, catId, [...new Set([...current, ...newDomains])].sort());
      newDomains.forEach(d => allExisting.add(d));
    }
  }

  // Dead-domain cleanup (--cleanup flag, skipped in dry-run)
  if (CLEANUP && !DRY_RUN) {
    html = await removeDeadDomains(html, extractCats(html));
  } else if (CLEANUP) {
    console.log('\n[DRY RUN] Skipping DNS cleanup.');
  }

  if (!DRY_RUN) {
    fs.writeFileSync(INDEX_PATH, html);
    const total = [...new Set(extractCats(html).flatMap(c => c.domains))].length;
    console.log(`\nindex.html updated — total unique domains: ${total}`);
  } else {
    console.log('\n[DRY RUN] No files written.');
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
