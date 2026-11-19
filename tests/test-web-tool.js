'use strict';
// tests/test-web-tool.js - what the web tool (index.html) puts into a download
//
//   node --test tests/test-web-tool.js
//
// Runs the tool's own getContent() and renderPreview() from index.html in a
// sandbox with every category selected. WEB_TOOL=<path> tests another copy.
//
// Zone files (RPZ) only know ";" comments: until 20 Nov 2026 the RPZ download
// had "#" lines, which BIND reads as broken records.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const src  = fs.readFileSync(process.env.WEB_TOOL || path.join(__dirname, '..', 'index.html'), 'utf8');
const grab = (re, what) => { const m = src.match(re); assert.ok(m, `index.html: ${what} not found`); return m[0]; };
const code = [
  grab(/const CATS=\[[\s\S]*?\];/, 'CATS'),
  grab(/const FMTS=\[[\s\S]*?\n\];/, 'FMTS'),
  grab(/function getDomains\(\)\{.*\}/, 'getDomains'),
  grab(/function getContent\(\)\{[\s\S]*?\n\}/, 'getContent'),
  grab(/function renderPreview\(\)\{[\s\S]*?\n\}/, 'renderPreview'),
  grab(/function esc\(s\)\{.*\}/, 'esc'),
  'this.CATS = CATS; this.FMTS = FMTS; this.getContent = getContent; this.renderPreview = renderPreview;',
].join('\n');

const els = {};
const box = { lang: 'en', I18N: { en: { empty: '' } },
  document: { getElementById: id => (els[id] ||= { textContent: '', innerHTML: '' }) } };
vm.createContext(box);
vm.runInContext(code, box);
vm.runInContext('var active = new Set(CATS.map(c => c.id)); var fmt = FMTS[0];', box);

const run = id => { vm.runInContext(`fmt = FMTS.find(f => f.id === ${JSON.stringify(id)});`, box); return box.getContent().split('\n'); };
const cmtOf = id => id === 'rpz' ? ';' : '#';
// Arrays from the sandbox have its own prototype: copy them before deepEqual.
const domains = Array.from(box.CATS.flatMap(c => c.domains));

test('the tool offers the six formats', () => {
  assert.deepEqual(Array.from(box.FMTS, f => f.id).sort(), ['adguard', 'dnsmasq', 'hosts', 'pihole', 'rpz', 'unbound']);
});

for (const id of ['dnsmasq', 'hosts', 'pihole', 'rpz', 'adguard', 'unbound']) {
  test(`${id}: header and category lines are "${cmtOf(id)}" comments, one line per domain`, () => {
    const f = box.FMTS.find(x => x.id === id);
    const lines = run(id), c = cmtOf(id), other = c === ';' ? '#' : ';';
    assert.ok(lines[0].startsWith(c + ' ====='), `first line: ${lines[0]}`);
    assert.deepEqual(lines.filter(l => l.startsWith(other)), [], `lines starting with "${other}"`);
    assert.equal(lines.filter(l => l.startsWith(c + ' --- ')).length, box.CATS.length, 'one separator per category');
    assert.deepEqual(lines.filter(l => l && !l.startsWith(c)), Array.from(domains, d => f.fn(d)));
  });
}

test('the preview shows the RPZ comments as comments', () => {
  run('rpz');
  box.renderPreview();
  const html = els.preview.innerHTML;
  const shown = [...html.matchAll(/<span class="c-cmt">(.*?)<\/span>/g)].map(m => m[1]);
  const comments = box.getContent().split('\n').filter(l => l.startsWith(';'));
  assert.equal(shown.length, comments.length, 'every ";" line is shown as a comment');
  assert.doesNotMatch(html, /<span class="c-(dom|key)">;/, 'a ";" line is shown as a rule');
});

// 81.cn stood twice in Chinese State Media (until 20 Nov 2026): the category
// showed 33 domains for 32, and the download listed it twice.
test('every domain appears once in the whole tool', () => {
  const seen = new Map(), twice = [];
  for (const c of box.CATS) for (const d of c.domains) {
    if (seen.has(d)) twice.push(`${d} (${seen.get(d)} and ${c.id})`);
    else seen.set(d, c.id);
  }
  assert.deepEqual(twice, []);
});

// The footer said "MIT License" in every language, but the automatic categories
// are not MIT (until 20 Nov 2026). It now says the code is MIT and links to the
// license notes in the README, in all six languages.
const I18N = vm.runInContext(`(${grab(/const I18N=(\{[\s\S]*?\n\});/, 'I18N').replace(/^const I18N=/, '').replace(/;$/, '')})`, box);
const LANGS = ['de', 'en', 'it', 'es', 'fr', 'pt'];

test('every language has every text, none empty', () => {
  assert.deepEqual(Object.keys(I18N).sort(), [...LANGS].sort());
  const keys = new Set(LANGS.flatMap(l => Object.keys(I18N[l])));
  for (const l of LANGS) for (const k of keys)
    assert.ok(typeof I18N[l][k] === 'string' && I18N[l][k].trim(), `${l}: "${k}" missing or empty`);
});

test('the footer links to the license notes and is set in every language', () => {
  const footer = grab(/<div class="footer">[\s\S]*?\n<\/div>/, 'footer');
  const link = footer.match(/<a [^>]*id="t-footer-lic"[^>]*>/);
  assert.ok(link, 'no link with id t-footer-lic in the footer');
  assert.match(link[0], /href="https:\/\/github\.com\/DanielEnki420\/dns-blocklist-builder#license"/);
  const set = {};
  const doc = { documentElement: {}, querySelectorAll: () => [],
    getElementById: id => (set[id] ||= { textContent: '', childNodes: [{}] }) };
  const ctx = vm.createContext({ I18N, document: doc, track() {}, renderCats() {}, renderPreview() {}, lang: '' });
  vm.runInContext(grab(/function setLang\(l\)\{[\s\S]*?\n\}/, 'setLang'), ctx);
  for (const l of LANGS) {
    vm.runInContext(`setLang(${JSON.stringify(l)})`, ctx);
    assert.equal(set['t-footer-lic'].textContent, I18N[l].footerLic, `${l}: link text not set`);
    assert.equal(set['t-footer'].textContent, I18N[l].footer, `${l}: footer not set`);
    assert.match(I18N[l].footer, /MIT/, `${l}: footer does not mention MIT`);
  }
});
