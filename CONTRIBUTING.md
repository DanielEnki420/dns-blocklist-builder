# Contributing to DNS Blocklist Builder

Thank you for helping improve this project! There are several ways to contribute.

## Suggesting a Domain

1. Open an issue with the [domain template](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=domain_suggestion.md)
2. Use the title: `[suggestion] example.com`
3. Include:
   - The domain(s) to add
   - Which category it belongs to
   - A brief reason / source (news article, fact-check, etc.)

**Please do not suggest domains without a verifiable reason.**

## Suggesting a New Category

Open an issue with the [category template](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=category_suggestion.md), title `[category] Category Name`, and describe:
- What kind of sites the category covers
- At least 10 example domains with sources

## Reporting an Incorrect Domain

If a domain was added by mistake (e.g. legitimate site), open an issue with the [false positive template](https://github.com/DanielEnki420/dns-blocklist-builder/issues/new?template=false_positive.md):
- Title: `[remove] example.com`
- Why it should be removed, and what breaks while it is blocked

Domains in tracking, malware and phishing come from public lists every week, so
deleting them in `index.html` does not last. They go into `allowlist.txt` instead
(one exact domain per line, with the reason and the issue); a push of that file
rebuilds the lists. A pull request that adds such a line is welcome.

Do not edit `auto-domains.json` by hand: the update keeps it, and it decides which
domains may expire. Domains you add to `index.html` yourself are not in it and stay.

## Pull Requests

Pull requests for domain additions are welcome. Please:
- Edit only the `CATS` array in `index.html`
- Keep one category per PR if possible
- Add domains alphabetically within a category
- Include sources in the PR description

## Code Contributions

For UI/code changes:
- Open an issue first to discuss the change
- Keep the tool dependency-free and offline-capable
- Do not add external scripts, fonts, or trackers

## Code of Conduct

Be respectful. Domain inclusion decisions are based on documented evidence of disinformation, propaganda, or harmful content — not political opinion.
