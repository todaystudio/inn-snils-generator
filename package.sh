#!/bin/bash
# package.sh — собирает чистый ZIP для публикации в Chrome Web Store.
# В пакет попадают только файлы, нужные для работы расширения.

set -e

VERSION=$(node -p "require('./manifest.json').version")
OUTPUT="inn-snils-generator-v${VERSION}.zip"

rm -f "$OUTPUT"

zip -r "$OUTPUT" . \
  -x ".git/*" \
  -x ".DS_Store" \
  -x ".zcode/*" \
  -x "node_modules/*" \
  -x "*.map" \
  -x "CHROMEWEBSTORE.md" \
  -x "README.md" \
  -x "PRIVACY.md" \
  -x "package.sh" \
  -x "store-assets/*" \
  -x "dev/*" \
  -x "icons/icon.svg" \
  -x "icons/promo-tile.png" \
  -x "*.zip"

echo "✓ Собран: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "  Содержимое:"
unzip -l "$OUTPUT" | tail -n +2
