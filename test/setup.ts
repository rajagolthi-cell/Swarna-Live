import { beforeEach } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env as raw } from 'cloudflare:workers';
import { googleDeps } from '../src/worker/google/client';

const env = raw as unknown as { DB: D1Database; PHOTOS: R2Bucket; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = ['sync_jobs', 'drive_folders', 'oauth_states', 'google_connections', 'audit_log', 'quotes', 'photos', 'order_counters',
  'rate_versions', 'rate_limits', 'recovery_codes', 'sessions', 'business_invites', 'owner_accounts', 'staff', 'businesses'];

const realFetch = googleDeps.fetch;

// Every test starts with an empty database and bucket.
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  let cursor: string | undefined;
  do {
    const list = await env.PHOTOS.list({ cursor });
    if (list.objects.length) await env.PHOTOS.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  googleDeps.fetch = realFetch;
});
