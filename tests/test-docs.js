'use strict';
// tests/test-docs.js - the issue templates, the links to them, and the
// license notes for the sources
//
//   node --test tests/test-docs.js
//
// README.md linked to two templates that did not exist (until 19 Nov 2026), so
// every "Open a GitHub Issue" link opened an empty issue.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const root  = path.join(__dirname, '..');
const tdir  = path.join(root, '.github', 'ISSUE_TEMPLATE');
const read  = f => fs.readFileSync(path.join(root, f), 'utf8');
const templates = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(f => f.endsWith('.md')) : [];

test('every template link in the docs and the web tool points to a template', () => {
  let links = 0;
  for (const f of ['README.md', 'CONTRIBUTING.md', 'index.html']) {
    for (const [, name] of read(f).matchAll(/issues\/new\?template=([\w.-]+)/g)) {
      links++;
      assert.ok(templates.includes(name), `${f} links to ${name}, which is not in .github/ISSUE_TEMPLATE/`);
    }
  }
  assert.ok(links >= 4, `only ${links} template links found`);
});

test('every template has a name, a description and a title', () => {
  assert.ok(templates.length >= 4, `templates: ${templates.join(', ')}`);
  for (const t of templates) {
    const head = fs.readFileSync(path.join(tdir, t), 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(head, `${t}: no front matter`);
    for (const key of ['name', 'about', 'title'])
      assert.match(head[1], new RegExp(`^${key}: \\S`, 'm'), `${t}: no ${key}`);
  }
});

test('the domain template names every category of the web tool', () => {
  const cats = eval(read('index.html').match(/const CATS=(\[[\s\S]*?\]);/)[1]);
  const text = fs.readFileSync(path.join(tdir, 'domain_suggestion.md'), 'utf8').replace(/\s+/g, ' ');
  for (const c of cats) assert.ok(text.includes(c.name.en), `missing: ${c.name.en}`);
});

// The automatic categories copy domains from public lists, and some of them are
// GPL-3.0. Until 19 Nov 2026 the README said only "MIT"; a new source must come
// with its terms.
test('the license section names every source of the weekly update', () => {
  const { SOURCES } = require('../fetch-domains.js');
  const section = read('README.md').split(/^## License$/m)[1];
  assert.ok(section, 'README.md has no "## License" section');
  for (const s of SOURCES)
    assert.ok(section.includes(s.name), `the license section in README.md does not name "${s.name}": add its terms`);
});
