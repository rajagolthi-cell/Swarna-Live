#!/usr/bin/env bash
# One-time setup of Swarna Live on Cloudflare, then deploy to swarnalive.com.
#
# Needs a Cloudflare API token in CLOUDFLARE_API_TOKEN (see README) and,
# if the token can see more than one account, CLOUDFLARE_ACCOUNT_ID.
# Safe to run again: existing database/bucket are reused.
set -euo pipefail
cd "$(dirname "$0")/.."

export WRANGLER_SEND_METRICS=false
DB_NAME=swarna-live-db
BUCKET=swarna-live-files
W="npx --no-install wrangler"

echo "==> Checking Cloudflare login"
$W whoami

echo "==> D1 database ($DB_NAME)"
if grep -q 'REPLACE_WITH_D1_DATABASE_ID' wrangler.toml; then
  DB_ID=$($W d1 list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const db=JSON.parse(s).find(d=>d.name==='$DB_NAME');process.stdout.write(db?db.uuid:'')})")
  if [ -z "$DB_ID" ]; then
    $W d1 create "$DB_NAME" --location apac
    DB_ID=$($W d1 list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.parse(s).find(d=>d.name==='$DB_NAME').uuid)})")
  fi
  sed -i.bak "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/" wrangler.toml && rm -f wrangler.toml.bak
  echo "    database_id = $DB_ID (saved in wrangler.toml)"
else
  echo "    already configured in wrangler.toml"
fi

echo "==> R2 bucket ($BUCKET)"
if $W r2 bucket list 2>/dev/null | grep -q "name:\s*$BUCKET\$"; then
  echo "    already exists"
else
  $W r2 bucket create "$BUCKET" --location apac
fi

echo "==> Database tables"
$W d1 migrations apply "$DB_NAME" --remote

echo "==> Setup code for the first admin account"
if $W secret list 2>/dev/null | grep -q '"SETUP_CODE"'; then
  echo "    already set (keep using the code you saved earlier)"
else
  CODE=$(node -e "const c=require('crypto').randomBytes(6).toString('hex').toUpperCase();console.log(c.slice(0,4)+'-'+c.slice(4,8)+'-'+c.slice(8))")
  # The Worker must exist before a secret can be added to it.
  $W deploy
  printf '%s' "$CODE" | $W secret put SETUP_CODE
  echo
  echo "    ******************************************************"
  echo "    SETUP CODE:  $CODE"
  echo "    You need this once, to create the first admin account."
  echo "    ******************************************************"
fi

echo "==> Deploying to swarnalive.com"
$W deploy
echo "Done. Open https://swarnalive.com"
