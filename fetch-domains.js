#!/usr/bin/env node
'use strict';
// fetch-domains.js — fetches new domains from external sources → index.html
//
// Usage:
//   node fetch-domains.js             fetch new domains
//   node fetch-domains.js --cleanup   also remove domains that no longer resolve via DNS
//   node fetch-domains.js --dry-run   preview changes without writing any files
//
// A source that fails (HTTP error, timeout, too few valid domains) is skipped so the
// others still update, and it is reported: listed at the end, as a GitHub
// warning in Actions, and written to $FAILED_SOURCES_FILE if that is set (the
// weekly workflow turns a non-empty file into a failed run, so it is noticed).
// Tests: node --test tests/test-fetch-domains.js

const crypto = require('crypto');
const https = require('https');
const http  = require('http');
const dns   = require('dns').promises;
const fs    = require('fs');
const path  = require('path');

const INDEX_PATH = path.join(__dirname, 'index.html');
const CACHE_DIR  = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'source-cache.json');

// Domain must appear in ≥MIN_SOURCES sources within its category before being added.
// Only applied when a category has ≥2 sources; otherwise all valid domains are candidates.
const MIN_SOURCES  = 2;
const DNS_BATCH    = 30; // concurrent DNS lookups during cleanup

// ── Sources ───────────────────────────────────────────────────────────────────
// Each source maps to a category id from the CATS array in index.html.
// maxNew caps how many new domains are added per category per run after filtering
// (a safety valve should a source go bad; the rest follows in the next runs).
// minEntries: fewer valid domains than this counts as a failed source - a 200
// with an error page, a changed format or an abandoned list (Disconnect Malware
// shrank to one test domain and went unnoticed that way).
// Every source needs a sample of its format in tests/test-fetch-domains.js.
const SOURCES = [
  // tracking: ads and tracking. Hagezi takes yoyo as one of its inputs, so here
  // the second source is Hagezi's curation of yoyo (popular domains only, few
  // false positives) rather than an independent confirmation.
  {
    cat: 'tracking', maxNew: 100, minEntries: 1000,
    name: "Peter Lowe's Ad & Tracking List",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext',
  },
  {
    cat: 'tracking', maxNew: 100, minEntries: 10,
    name: 'Disconnect.me Tracking',
    url: 'https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt',
  },
  {
    cat: 'tracking', maxNew: 100, minEntries: 10000,
    name: 'Hagezi Multi Light',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/light-onlydomains.txt',
  },
  // malware: URLhaus hosts that are online now (abuse.ch ended its free hostfile,
  // malware-filter rebuilds it from the URLhaus API twice a day and leaves out
  // popular domains), confirmed by Hagezi's threat feeds, which do not use URLhaus.
  // Online only: cleaned-up sites still resolve and would never leave the list.
  {
    cat: 'malware', maxNew: 300, minEntries: 50,
    name: 'malware-filter (URLhaus)',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt',
    hostsFormat: true, // "0.0.0.0 domain" lines
  },
  {
    cat: 'malware', maxNew: 300, minEntries: 10000,
    name: 'Hagezi Threat Intelligence Feeds (mini)',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.mini-onlydomains.txt',
  },
  {
    cat: 'phishing', maxNew: 100, minEntries: 10000,
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

function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function saveCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function httpGet(urlStr, headers = {}, hops = 0) {
  if (hops > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
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
          const err = new Error(`HTTP ${res.statusCode} for ${urlStr}`);
          err.status = res.statusCode;
          return reject(err);
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

// Timeouts, network errors, 429 and 5xx may pass; 404 or 410 will not.
const retryable = err => !err.status || err.status === 429 || err.status >= 500;

async function fetchSource(source, cache, retryDelayMs) {
  const cached = cache[source.url];
  const condHeaders = {};
  if (cached?.etag)          condHeaders['If-None-Match']     = cached.etag;
  else if (cached?.lm)       condHeaders['If-Modified-Since'] = cached.lm;

  let res;
  try {
    res = await httpGet(source.url, condHeaders);
  } catch (err) {
    if (!retryable(err)) throw err;
    process.stdout.write(`${err.message}, retrying... `);
    await new Promise(r => setTimeout(r, retryDelayMs));
    res = await httpGet(source.url, condHeaders);
  }

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
// opts are for the tests; the defaults are the real run
async function main({
  sources     = SOURCES,
  indexPath   = INDEX_PATH,
  cacheFile   = CACHE_FILE,
  failedFile  = process.env.FAILED_SOURCES_FILE,
  summaryFile = process.env.GITHUB_STEP_SUMMARY,
  argv        = process.argv,
  retryDelayMs = 10000,
} = {}) {
  const DRY_RUN = argv.includes('--dry-run');
  const CLEANUP = argv.includes('--cleanup');
  console.log(`fetch-domains.js${DRY_RUN ? ' [DRY RUN]' : ''}${CLEANUP ? ' [+CLEANUP]' : ''}\n`);

  let html   = fs.readFileSync(indexPath, 'utf8');
  const CATS = extractCats(html);

  // Global existing-domain set — new domains must not already live in any category
  const allExisting = new Set(CATS.flatMap(c => c.domains.map(d => d.toLowerCase())));
  console.log(`Existing: ${allExisting.size} domains in ${CATS.length} categories\n`);

  // Source count per category (used to decide whether to apply MIN_SOURCES filter)
  const srcCount = {};
  for (const s of sources) srcCount[s.cat] = (srcCount[s.cat] || 0) + 1;

  const cache  = loadCache(cacheFile);
  const failed = []; // { name, reason }
  const status = []; // { name, cat, ok, count, reason } for the run summary

  // Collect: catId → Map<domain, Set<sourceName>>
  const seen = {};

  for (const source of sources) {
    process.stdout.write(`Fetching ${source.name}... `);
    let domains;
    try {
      domains = await fetchSource(source, cache, retryDelayMs);
      const min = source.minEntries ?? 1;
      if (domains.length < min)
        throw new Error(`only ${domains.length} valid domains, expected at least ${min}`);
      console.log(`${domains.length.toLocaleString()} domains`);
      status.push({ name: source.name, cat: source.cat, ok: true, count: domains.length });
    } catch (err) {
      console.log(`SKIP — ${err.message}`);
      failed.push({ name: source.name, reason: err.message });
      status.push({ name: source.name, cat: source.cat, ok: false, reason: err.message });
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

  saveCache(cacheFile, cache);

  // A category whose filter needs two sources but has fewer than two working
  // ones cannot grow at all - the silent state this check exists for.
  const frozen = [];
  for (const [catId, n] of Object.entries(srcCount)) {
    const working = status.filter(x => x.cat === catId && x.ok).length;
    if (n >= MIN_SOURCES && working < MIN_SOURCES) frozen.push({ cat: catId, working, of: n });
  }

  // Filter by min appearances (counted against the configured sources, so a
  // failed source never loosens the filter) and apply the per-category cap.
  // Over the cap, candidates are taken in the order of a hash of the name: a
  // fixed but spread-out order. Alphabetical order took only names starting
  // with a digit, week after week.
  const additions = {};
  for (const [catId, domainMap] of Object.entries(seen)) {
    const minApp     = srcCount[catId] >= MIN_SOURCES ? MIN_SOURCES : 1;
    const maxNew     = Math.max(...sources.filter(s => s.cat === catId).map(s => s.maxNew));
    const candidates = [...domainMap.entries()]
      .filter(([, srcs]) => srcs.size >= minApp)
      .map(([d]) => d);
    const filtered = candidates
      .map(d => [crypto.createHash('sha256').update(d).digest('hex'), d])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, maxNew)
      .map(([, d]) => d)
      .sort();
    if (candidates.length > maxNew)
      console.log(`  ${catId}: ${candidates.length} candidates, cap ${maxNew} per run — the rest follows in later runs`);
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
    fs.writeFileSync(indexPath, html);
    const total = [...new Set(extractCats(html).flatMap(c => c.domains))].length;
    console.log(`\nindex.html updated — total unique domains: ${total}`);
  } else {
    console.log('\n[DRY RUN] No files written.');
  }

  report(failed, frozen, status, failedFile, summaryFile);
  return { additions, failed, frozen };
}

// Lists failed sources and frozen categories. The file gets one line per problem
// and is written on every run, empty if all is well, so the workflow can fail
// on a non-empty file and on a missing one.
function report(failed, frozen, status, failedFile, summaryFile) {
  const gh = !!process.env.GITHUB_ACTIONS;
  const lines = [];
  for (const f of frozen) {
    const msg = `category ${f.cat}: only ${f.working} of ${f.of} sources working — it gets no new domains`;
    lines.push(msg);
    console.log(`\n${msg}`);
    if (gh) console.log(`::error title=Category frozen::${msg}`);
  }
  if (failed.length) console.log(`\n${failed.length} source(s) failed:`);
  for (const f of failed) {
    lines.push(`${f.name}: ${f.reason}`);
    console.log(`  ${f.name}: ${f.reason}`);
    if (gh) console.log(`::warning title=Source failed::${f.name}: ${f.reason}`);
  }
  if (failedFile) fs.writeFileSync(failedFile, lines.map(l => l + '\n').join(''));
  if (summaryFile) {
    const rows = status.map(x => `| ${x.ok ? '✅' : '❌'} | ${x.cat} | ${x.name} | ${x.ok ? x.count : x.reason} |`);
    fs.appendFileSync(summaryFile, ['### Sources', '', '| | Category | Source | Domains |', '|---|---|---|---|', ...rows,
      ...frozen.map(f => `\n**${f.cat}: only ${f.working} of ${f.of} sources working.**`), ''].join('\n') + '\n');
  }
}

module.exports = { SOURCES, parseDomains, isValidDomain, main };

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
