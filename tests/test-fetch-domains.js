'use strict';
// tests/test-fetch-domains.js - tests for fetch-domains.js
//
//   node --test tests/test-fetch-domains.js
//
// No network: a local HTTP server serves the source lists, and every run works
// on a copy of index.html in a temporary directory. FETCH_DOMAINS=<path> runs
// the same tests against another copy of the script (for the counter-check).

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { execFile } = require('node:child_process');

const root   = path.join(__dirname, '..');
const script = path.resolve(process.env.FETCH_DOMAINS || path.join(root, 'fetch-domains.js'));
const fd     = require(script);

// The head of each configured source as it looked on 19 Nov 2026: comments,
// headers and the first entries, in the source's own format. A new source needs
// a sample here, so its format is checked before the weekly run meets it.
const SAMPLES = {
  "Peter Lowe's Ad & Tracking List": {
    text: '101com.com\n180hits.de\n2mdn.net\n',
    want: ['101com.com', '180hits.de', '2mdn.net'],
  },
  'Disconnect.me Tracking': {
    text: '# Basic tracking list by Disconnect\n# License: GPLv3\n# Contact: support [at] disconnect.me\n\nadjust.io\nairbrake.io\n',
    want: ['adjust.io', 'airbrake.io'],
  },
  'Hagezi Multi Light': {
    text: "# Title: HaGeZi's Multi LIGHT - basic protection\n# Syntax: Domains (without subdomains)\n# Number of entries: 91291\n#\n2mdn.net\nadjust.io\n",
    want: ['2mdn.net', 'adjust.io'],
  },
  'malware-filter (URLhaus)': {
    text: '# Title: Malicious Hosts Blocklist\n# Source: https://urlhaus.abuse.ch/api/\n0.0.0.0 02teste.cc\n0.0.0.0 0x1x2x3.top\n',
    want: ['02teste.cc', '0x1x2x3.top'],
  },
  'Hagezi Threat Intelligence Feeds (mini)': {
    text: "# Title: HaGeZi's Threat Intelligence Feeds - mini version\n# Syntax: Domains (without subdomains)\n#\npl.0003201.site\ntestingirs.000a.de\n",
    want: ['pl.0003201.site', 'testingirs.000a.de'],
  },
  'Phishing Army Blocklist': {
    text: '#\n# Title: Phishing Army | Community phishing domain blocklist\n# Format: domains; version=1\n#\n0121z3.ralind.at\n047589294903.cfd\n',
    want: ['0121z3.ralind.at', '047589294903.cfd'],
  },
};

// serve ROUTES - on a free local port. A route is [status, body], or a function
// of the request number (1, 2, ...) that returns one, or 'drop' to cut the
// connection. hits[path] counts the requests.
async function serve(routes, hits = {}) {
  const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    let route = routes[req.url] || [404, 'not found'];
    if (typeof route === 'function') route = route(hits[req.url]);
    if (route === 'drop') return req.socket.destroy();
    const [status, body] = route;
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(r => server.close(r)) };
}

// run SOURCES ROUTES [ARGV] - fetch-domains on a copy of index.html, in its own
// process (its output stays out of the test report); returns what main() returned,
// its output, the resulting index.html and the failed-sources file
async function run(sources, routes, argv = ['node', 'fetch-domains.js'], hits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-domains-'));
  const indexPath = path.join(dir, 'index.html');
  fs.copyFileSync(path.join(root, 'index.html'), indexPath);
  const srv = await serve(routes, hits);
  try {
    const opts = {
      sources: sources.map(s => ({ ...s, url: srv.base + s.url })),
      indexPath,
      cacheFile:  path.join(dir, 'cache', 'source-cache.json'),
      failedFile:  path.join(dir, 'failed-sources.txt'),
      summaryFile: path.join(dir, 'summary.md'),
      argv,
      retryDelayMs: 10,
    };
    const driver = `require(${JSON.stringify(script)}).main(${JSON.stringify(opts)})
      .then(r => require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'result.json'))}, JSON.stringify(r)))`;
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS; delete env.FAILED_SOURCES_FILE;
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', driver], { env }, (err, stdout, stderr) =>
        err ? reject(new Error(`${err.message}\n${stdout}${stderr}`)) : resolve(stdout));
    });
    return { ...JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')), out,
             html: fs.readFileSync(indexPath, 'utf8'),
             failedText: fs.readFileSync(opts.failedFile, 'utf8'),
             summary: fs.readFileSync(opts.summaryFile, 'utf8') };
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const trackingIn = html => html.match(/\{id:'tracking'.*?domains:\[([^\]]*)\]/)[1];
const src = (name, url, extra = {}) => ({ cat: 'tracking', maxNew: 300, name, url, ...extra });

test('every configured source has a sample of its real format, and it parses', () => {
  for (const s of fd.SOURCES) {
    const sample = SAMPLES[s.name];
    assert.ok(sample, `no sample for "${s.name}" (${s.url})`);
    assert.deepEqual(fd.parseDomains(sample.text, s.hostsFormat), sample.want, s.name);
  }
});

test('every category with a confirmation filter has at least two sources', () => {
  const perCat = {};
  for (const s of fd.SOURCES) (perCat[s.cat] ||= []).push(s.name);
  for (const cat of ['tracking', 'malware'])
    assert.ok((perCat[cat] || []).length >= 2, `${cat}: ${perCat[cat]}`);
});

test('a domain is added only when two sources of its category list it', async () => {
  const r = await run(
    [src('A', '/a'), src('B', '/b')],
    { '/a': [200, 'one-only-a.net\nboth-ab.net\n'], '/b': [200, 'both-ab.net\none-only-b.net\n'] },
  );
  assert.deepEqual(r.additions.tracking, ['both-ab.net']);
  assert.match(trackingIn(r.html), /'both-ab\.net'/);
  assert.doesNotMatch(trackingIn(r.html), /one-only/);
});

test('over the cap the pick is spread over the alphabet, the same on every run, and said', async () => {
  const names = [...'abcdefghijklmnopqrstuvwxyz'].map(c => `${c}-cap.net`);
  const list  = names.join('\n') + '\n';
  const sources = [src('A', '/a', { maxNew: 5 }), src('B', '/b', { maxNew: 5 })];
  const r1 = await run(sources, { '/a': [200, list], '/b': [200, list] });
  const r2 = await run(sources, { '/a': [200, list], '/b': [200, list] });
  assert.equal(r1.additions.tracking.length, 5);
  assert.notDeepEqual(r1.additions.tracking, names.slice(0, 5), 'took the first five alphabetically');
  assert.deepEqual(r2.additions.tracking, r1.additions.tracking);
  assert.match(r1.out, /tracking: 26 candidates, cap 5 per run/);
});

test('a source that fails is reported, and the others still update', async () => {
  const r = await run(
    [src('A', '/a'), src('B', '/b'), src('Gone', '/gone')],
    { '/a': [200, 'both-ab.net\n'], '/b': [200, 'both-ab.net\n'], '/gone': [410, 'Gone'] },
  );
  assert.deepEqual(r.additions.tracking, ['both-ab.net']);
  assert.deepEqual(r.failed.map(f => f.name), ['Gone']);
  assert.match(r.failedText, /^Gone: HTTP 410/);
  assert.match(r.out, /1 source\(s\) failed/);
});

test('a source that answers 200 without any domain counts as failed', async () => {
  const r = await run(
    [src('A', '/a'), src('Page', '/page')],
    { '/a': [200, 'both-ab.net\n'], '/page': [200, '<!DOCTYPE html>\n<html><body>moved</body></html>\n'] },
  );
  assert.deepEqual(r.failed.map(f => f.name), ['Page']);
  assert.match(r.failedText, /^Page: only 0 valid domains/m);
});

test('a source below its minimum of entries counts as failed', async () => {
  const r = await run(
    [src('A', '/a'), src('B', '/b'), src('Thin', '/thin', { minEntries: 10 })],
    { '/a': [200, 'both-ab.net\n'], '/b': [200, 'both-ab.net\n'],
      '/thin': [200, 'Malware list by Disconnect\nmalware-check.disconnect.me\n'] },
  );
  assert.deepEqual(r.failed.map(f => f.name), ['Thin']);
  assert.match(r.failedText, /^Thin: only 1 valid domains, expected at least 10/);
});

test('one of two sources down: nothing is added and the category is reported frozen', async () => {
  const r = await run(
    [src('A', '/a'), src('Gone', '/gone')],
    { '/a': [200, 'only-in-a.net\nalso-in-a.net\n'], '/gone': [410, 'Gone'] },
  );
  assert.equal(r.additions.tracking, undefined);
  assert.doesNotMatch(trackingIn(r.html), /in-a\.net/);
  assert.deepEqual(r.frozen, [{ cat: 'tracking', working: 1, of: 2 }]);
  assert.match(r.failedText, /^category tracking: only 1 of 2 sources working/m);
});

test('a 503 or a cut connection is tried once more, a 410 is not', async () => {
  const hits = {};
  const r = await run(
    [src('A', '/a'), src('B', '/b'), src('Gone', '/gone')],
    { '/a': n => (n === 1 ? [503, 'busy'] : [200, 'both-ab.net\n']),
      '/b': n => (n === 1 ? 'drop' : [200, 'both-ab.net\n']),
      '/gone': [410, 'Gone'] },
    undefined, hits,
  );
  assert.deepEqual(r.additions.tracking, ['both-ab.net']);
  assert.deepEqual(hits, { '/a': 2, '/b': 2, '/gone': 1 });
});

test('the run summary lists every source with its state', async () => {
  const r = await run([src('A', '/a'), src('Gone', '/gone')],
                      { '/a': [200, 'both-ab.net\n'], '/gone': [404, ''] });
  assert.match(r.summary, /\| ✅ \| tracking \| A \| 1 \|/);
  assert.match(r.summary, /\| ❌ \| tracking \| Gone \| HTTP 404/);
  assert.match(r.summary, /tracking: only 1 of 2 sources working/);
});

test('with every source working the failed-sources file is empty', async () => {
  const r = await run([src('A', '/a'), src('B', '/b')],
                      { '/a': [200, 'both-ab.net\n'], '/b': [200, 'both-ab.net\n'] });
  assert.deepEqual(r.failed, []);
  assert.equal(r.failedText, '');
});

test('a dry run reports failures but writes no domains', async () => {
  const before = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const r = await run([src('A', '/a'), src('B', '/b'), src('Gone', '/gone')],
                      { '/a': [200, 'both-ab.net\n'], '/b': [200, 'both-ab.net\n'], '/gone': [404, ''] },
                      ['node', 'fetch-domains.js', '--dry-run']);
  assert.equal(r.html, before);
  assert.deepEqual(r.failed.map(f => f.name), ['Gone']);
});
