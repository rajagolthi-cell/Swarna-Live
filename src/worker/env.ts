export interface SyncMessage {
  jobId: string;
}

export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  /** Optional Cloudflare Queue. Without it, jobs run right after a save and on the cron schedule. */
  SYNC_QUEUE?: Queue<SyncMessage>;

  APP_ENV: 'local' | 'staging' | 'production';
  /** Canonical origin, e.g. https://www.swarnalive.com. Used for redirects and the Google callback URL. */
  APP_ORIGIN: string;
  /** Other hostnames that should redirect to APP_ORIGIN (comma separated), e.g. "swarnalive.com". */
  REDIRECT_HOSTS?: string;
  /** "false" only for local http development. */
  COOKIE_SECURE?: string;

  // Secrets (wrangler secret put ...)
  AUTH_PEPPER: string;
  SETUP_TOKEN?: string;
  PLATFORM_ADMIN_TOKEN?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
