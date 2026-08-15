#!/usr/bin/env bash
# Validates the extension's static files. Run locally with:
#   bash scripts/validate.sh
# Used by .github/workflows/validate.yml on every push/PR.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Validating manifest.json =="
python3 -m json.tool manifest.json > /dev/null
echo "OK"

echo "== Checking JavaScript syntax =="
for f in content.js background.js popup.js options.js; do
  echo "  $f"
  node --check "$f"
done

echo "== Checking HTML parses =="
for f in popup.html options.html; do
  python3 -c "
import html.parser
class P(html.parser.HTMLParser):
    pass
P().feed(open('$f').read())
print('  $f OK')
"
done

echo "== Checking for accidentally committed Chrome extension private keys (*.pem) =="
if find . -name '*.pem' | grep -q .; then
  echo "ERROR: a .pem private key file is present in the repo. Remove it and rotate the key." >&2
  exit 1
fi
echo "OK"

echo "All checks passed."
