#!/usr/bin/env bash
# tests/test-rpz-zone.sh - BIND loads every generated RPZ file, with every rule
#
#   bash tests/test-rpz-zone.sh
#
# Needs named-checkzone and named-compilezone (Debian/Ubuntu: bind9-utils).
# Without them it skips, except in CI. Runs generate-lists.js in a temporary
# copy, so lists/ here is not touched. GENERATE_LISTS=<path> tests another copy.
#
# Until 19 Nov 2026 the RPZ files had no SOA and NS, and absolute owner names
# ("rt.com."): BIND loads no such file, and with an SOA it would still skip
# every rule as out-of-zone data. named-checkzone says OK even then, so this
# also counts the rules BIND loaded: two per domain (the name and "*.").
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
gen=${GENERATE_LISTS:-$root/generate-lists.js}

if ! command -v named-checkzone >/dev/null || ! command -v named-compilezone >/dev/null; then
  if [ -n "${CI:-}" ]; then echo "named-checkzone/named-compilezone missing (bind9-utils)"; exit 1; fi
  echo "SKIP: named-checkzone is not installed (Debian/Ubuntu: bind9-utils)"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0 fail=0
ok()  { echo "  ok    $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }

# check FILE - prints "<domains> <rules loaded> <wildcards loaded>", or fails
# when BIND does not load the file or reports out-of-zone data
check() {
  local f=$1 out domains
  domains=$(grep -c -v -E '^(;|\$|@|\*\.|$)' "$f" || true)
  out=$(named-checkzone rpz.test "$f" 2>&1) || { echo "not loaded: $(tail -n 2 <<<"$out" | tr '\n' ' ')"; return 1; }
  if grep -q -i 'out-of-zone' <<<"$out"; then echo "out-of-zone data: $(grep -i -m 1 'out-of-zone' <<<"$out")"; return 1; fi
  named-compilezone -q -o "$tmp/out.zone" rpz.test "$f" >/dev/null 2>&1 || { echo "named-compilezone failed"; return 1; }
  echo "$domains $(awk '$4 == "CNAME"' "$tmp/out.zone" | wc -l | tr -d ' ') $(awk '$4 == "CNAME" && $1 ~ /^\*\./' "$tmp/out.zone" | wc -l | tr -d ' ')"
}

echo "the check itself rejects the old format"
printf '; header\nrt.com. CNAME .\n' >"$tmp/old.rpz"
if check "$tmp/old.rpz" >/dev/null; then bad "a file without SOA is taken"; else ok "a file without SOA is not loaded"; fi
# shellcheck disable=SC2016 # $TTL is meant literally
printf '$TTL 3600\n@ IN SOA localhost. hostmaster.localhost. 1 86400 900 2592000 7200\n@ IN NS localhost.\nrt.com. CNAME .\n' >"$tmp/abs.rpz"
if check "$tmp/abs.rpz" >/dev/null; then bad "absolute owner names are taken"; else ok "absolute owner names are reported as out-of-zone"; fi

echo "generated RPZ files"
mkdir "$tmp/repo"
cp "$root/index.html" "$root/fetch-domains.js" "$tmp/repo/"
cp "$gen" "$tmp/repo/generate-lists.js"
(cd "$tmp/repo" && node generate-lists.js >/dev/null)
shopt -s nullglob
files=("$tmp"/repo/lists/*.rpz.txt "$tmp"/repo/lists/by-category/*.rpz.txt)
[ "${#files[@]}" -ge 2 ] || bad "only ${#files[@]} RPZ files generated"
for f in "${files[@]}"; do
  name=${f#"$tmp/repo/lists/"}
  if ! res=$(check "$f"); then bad "$name: $res"; continue; fi
  read -r domains rules wild <<<"$res"
  if [ "$domains" -gt 0 ] && [ "$rules" -eq $((2 * domains)) ] && [ "$wild" -eq "$domains" ]; then
    ok "$name: $domains domains, BIND loads $rules rules"
  else
    bad "$name: $domains domains, but BIND loads $rules rules ($wild with *.)"
  fi
done

echo "the named.conf example in the README"
# the first code block after "### BIND 9 (RPZ)", with the file path of this run
conf=$(awk '/^### BIND 9 \(RPZ\)/ { s = 1 } s && /^```/ { if (i) exit; i = 1; next } i' "$root/README.md")
if [ -z "$conf" ]; then
  bad "no code block under ### BIND 9 (RPZ) in README.md"
else
  printf '%s\n' "${conf//\/etc\/bind\/blocklist-all.rpz.txt/$tmp/repo/lists/blocklist-all.rpz.txt}" >"$tmp/named.conf"
  if out=$(named-checkconf -z "$tmp/named.conf" 2>&1) && grep -q 'rpz.blocklist/IN: loaded serial' <<<"$out" && ! grep -q -i 'out-of-zone' <<<"$out"; then
    ok "named-checkconf loads the zone with it"
  else
    bad "named-checkconf: $(tr '\n' ' ' <<<"$out" | cut -c1-200)"
  fi
fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
