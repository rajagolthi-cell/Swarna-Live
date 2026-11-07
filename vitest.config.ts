import fs from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Tests run inside the real Workers runtime (workerd) with local D1 and R2.
export default defineConfig(async () => {
  fs.mkdirSync('dist/client', { recursive: true }); // wrangler config points assets here
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            AUTH_PEPPER: 'test-pepper-test-pepper-test-pepper-0123456789',
            SETUP_TOKEN: 'test-setup-token-123456',
            PLATFORM_ADMIN_TOKEN: 'test-admin-token-0123456789abcdef0123456789',
            TOKEN_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
            GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-client-secret',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
    },
  };
});
