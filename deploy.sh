#!/usr/bin/env bash
set -euo pipefail

npx wrangler@latest d1 migrations apply openfloor-production --remote
npm run build
npx wrangler deploy --config dist/server/wrangler.json
