#!/usr/bin/env bash
set -euo pipefail

npm audit --omit=dev
npm test
npx --no-install wrangler d1 migrations apply DB --remote
npm run build
npm run verify:deploy-artifact
npx --no-install wrangler deploy --config dist/server/wrangler.json
