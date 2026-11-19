'use strict';
// tests/test-generate-lists.js - the headers of the generated list files
//
//   node --test tests/test-generate-lists.js
//
// Runs generate-lists.js in a temporary copy of the repo, so lists/ here is not
// touched. GENERATE_LISTS=<path> tests another copy of the generator.
//
// Subscribers never see the README, so every file says in its header which
// license applies (until 19 Nov 2026 none did), and the header must be a
// comment in the file's own format: zone files (RPZ) only know ";", a "#" line
// there is a broken record.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const gen  = process.env.GENERATE_LISTS || path.join(root, 'generate-lists.js');
const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-lists-'));
for (const f of ['index.html', 'fetch-domains.js']) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
fs.copyFileSync(gen, path.join(tmp, 'generate-lists.js'));
execFileSync(process.execPath, [path.join(tmp, 'generate-lists.js')], { cwd: tmp, stdio: 'ignore' });

const lists = path.join(tmp, 'lists');
const files = [
  ...fs.readdirSync(lists).filter(f => f.startsWith('blocklist-all.')).map(f => path.join(lists, f)),
  ...fs.readdirSync(path.join(lists, 'by-category')).map(f => path.join(lists, 'by-category', f)),
];
const auto  = new Set(require(path.join(root, 'fetch-domains.js')).SOURCES.map(s => s.cat));
const CATS  = eval(fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/const CATS=(\[[\s\S]*?\]);/)[1]);
const cmt   = f => f.endsWith('.rpz.txt') ? ';' : '#';
const head  = f => { const lines = fs.readFileSync(f, 'utf8').split('\n'); return lines.slice(0, lines.indexOf('') + 1 || 12); };
const LINK  = 'https://github.com/DanielEnki420/dns-blocklist-builder#license';

test('the generator writes 6 combined files and 6 per category', () => {
  assert.equal(files.length, 6 + 6 * CATS.length);
});

test('every header is a comment in the format of its file', () => {
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const c = cmt(f), other = c === ';' ? '#' : ';';
    assert.ok(text.startsWith(c + ' ====='), `${path.basename(f)}: header does not start with "${c}"`);
    const bad = text.split('\n').filter(l => l.startsWith(other));
    assert.deepEqual(bad, [], `${path.basename(f)}: lines starting with "${other}"`);
  }
});

test('every file names its license and links to the license notes', () => {
  for (const f of files) {
    const lic = head(f).filter(l => /^[#;] License: /.test(l));
    assert.equal(lic.length, 1, `${path.basename(f)}: ${lic.length} license lines`);
    assert.ok(lic[0].includes(LINK), `${path.basename(f)}: no link to ${LINK}`);
  }
});

test('automatic categories are not called MIT, hand-curated ones are', () => {
  for (const c of CATS) {
    const f = path.join(lists, 'by-category', `${c.id}.pihole.txt`);
    const lic = head(f).find(l => l.startsWith('# License: '));
    if (auto.has(c.id)) assert.match(lic, /not MIT/, `${c.id}: ${lic}`);
    else assert.match(lic, /^# License: MIT\b/, `${c.id}: ${lic}`);
  }
  const all = head(path.join(lists, 'blocklist-all.pihole.txt')).find(l => l.startsWith('# License: '));
  for (const c of CATS.filter(c => auto.has(c.id))) assert.ok(all.toLowerCase().includes(c.id), `combined file does not name ${c.id}: ${all}`);
});

test('the domain lines are unchanged: one per domain, no comment among them', () => {
  const all = [...new Set(CATS.flatMap(c => c.domains))];
  const pihole = fs.readFileSync(path.join(lists, 'blocklist-all.pihole.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  assert.deepEqual(pihole, [...all].sort());
  const rpz = fs.readFileSync(path.join(lists, 'blocklist-all.rpz.txt'), 'utf8').split('\n').filter(l => l && !/^[;$@]/.test(l));
  assert.deepEqual(rpz, [...all].sort().flatMap(d => [`${d} CNAME .`, `*.${d} CNAME .`]));
});

// RPZ files are zone files. Until 19 Nov 2026 they had no SOA and NS (BIND does
// not load such a file) and absolute owner names ("rt.com."), which lie outside
// the zone the user names in named.conf: BIND skipped every rule. The rules are
// relative now, with a "*." rule for the subdomains, as in the BIND manual.
const SOA = /^@ IN SOA localhost\. hostmaster\.localhost\. (\d+) 86400 900 2592000 7200$/;
const rpzFiles = files.filter(f => f.endsWith('.rpz.txt'));

test('every RPZ file is a zone: $TTL, SOA and NS before the rules, no $ORIGIN', () => {
  assert.equal(rpzFiles.length, 1 + CATS.length);
  for (const f of rpzFiles) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l && !l.startsWith(';'));
    assert.equal(lines[0], '$TTL 3600', path.basename(f));
    assert.match(lines[1], SOA, path.basename(f));
    assert.equal(lines[2], '@ IN NS localhost.', path.basename(f));
    const rules = lines.slice(3);
    assert.deepEqual(rules.filter(l => /^[$@]/.test(l)), [], `${path.basename(f)}: a second directive or apex record`);
    for (const r of rules) assert.match(r, /^(\*\.)?[a-z0-9][a-z0-9.-]*[a-z0-9] CNAME \.$/, `${path.basename(f)}: ${r}`);
  }
});

test('the RPZ serial stays while the rules stay, and grows when they change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-serial-'));
  for (const f of ['index.html', 'fetch-domains.js']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.copyFileSync(gen, path.join(dir, 'generate-lists.js'));
  const runGen = () => execFileSync(process.execPath, [path.join(dir, 'generate-lists.js')], { cwd: dir, stdio: 'ignore' });
  const serial = f => +fs.readFileSync(path.join(dir, 'lists', f), 'utf8').match(/^@ IN SOA \S+ \S+ (\d+) /m)[1];
  try {
    runGen();
    const first = { all: serial('blocklist-all.rpz.txt'), rt: serial('by-category/rt.rpz.txt') };
    assert.ok(first.all > 1700000000 && first.all < 2 ** 32, `serial ${first.all}`);
    runGen();
    assert.equal(serial('blocklist-all.rpz.txt'), first.all, 'same rules, new serial');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const one = CATS.find(c => c.id === 'tracking').domains[0];
    fs.writeFileSync(path.join(dir, 'index.html'), html.replace(`'${one}',`, ''));
    runGen();
    assert.ok(serial('blocklist-all.rpz.txt') > first.all, 'rules changed, serial did not grow');
    assert.equal(serial('by-category/rt.rpz.txt'), first.rt, 'an unchanged category got a new serial');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
