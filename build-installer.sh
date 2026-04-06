#!/bin/bash
# Rebuilds delt-installer.html with the latest source files embedded
set -e

cd "$(dirname "$0")"

echo "Bundling source files..."
tar czf /tmp/delt-bundle.tar.gz \
  server.js \
  package.json \
  config.default.json \
  install.sh \
  public/index.html \
  public/style.css \
  public/app.js

B64=$(base64 -i /tmp/delt-bundle.tar.gz)

echo "Injecting into HTML template..."
# Read template, replace placeholder
python3 -c "
with open('install.html', 'r') as f:
    html = f.read()
# Use install.html as the template (has __BUNDLE_PLACEHOLDER__ or a fresh copy)
# Actually rebuild from delt-installer.html but reset the bundle
with open('delt-installer.html', 'r') as f:
    html = f.read()
import re
# Replace existing base64 blob or placeholder
html = re.sub(r'const BUNDLE = \"[^\"]*\"', 'const BUNDLE = \"$B64\"', html)
with open('delt-installer.html', 'w') as f:
    f.write(html)
"

SIZE=$(wc -c < delt-installer.html | xargs)
echo "Done! delt-installer.html ($SIZE bytes)"
echo "Email this file — Gmail won't block it."

rm -f /tmp/delt-bundle.tar.gz
