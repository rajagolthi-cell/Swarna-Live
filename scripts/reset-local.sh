#!/usr/bin/env bash
# Wipes the LOCAL development database and photos (never touches Cloudflare).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .wrangler/state
npx wrangler d1 migrations apply DB --local --env local
