-- Swarna Live schema. Every business-owned row carries business_id and every
-- query filters on it. Times are UTC epoch milliseconds (INTEGER).
-- Money: integer paise. Weight: integer milligrams. Percent: basis points.

CREATE TABLE businesses (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  phone                TEXT,
  email                TEXT,
  address              TEXT,
  gstin                TEXT,
  logo_key             TEXT,
  logo_type            TEXT,
  default_pct_bp       INTEGER NOT NULL DEFAULT 6000,
  staff_min_pct_bp     INTEGER NOT NULL DEFAULT 5000,
  staff_max_pct_bp     INTEGER NOT NULL DEFAULT 6000,
  profile_lock_minutes INTEGER NOT NULL DEFAULT 10,
  session_hours        INTEGER NOT NULL DEFAULT 12,
  disabled             INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE staff (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id),
  name             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('owner','admin','employee')),
  permissions      TEXT NOT NULL DEFAULT '[]',
  pin_hash         TEXT NOT NULL,
  pin_must_change  INTEGER NOT NULL DEFAULT 0,
  pin_failures     INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER,
  disabled         INTEGER NOT NULL DEFAULT 0,
  session_epoch    INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_staff_business ON staff(business_id);

-- The business login (owner email + password). One per business.
CREATE TABLE owner_accounts (
  id                  TEXT PRIMARY KEY,
  business_id         TEXT NOT NULL UNIQUE REFERENCES businesses(id),
  staff_id            TEXT NOT NULL REFERENCES staff(id),
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT NOT NULL,
  disabled            INTEGER NOT NULL DEFAULT 0,
  password_changed_at INTEGER NOT NULL,
  created_at          INTEGER NOT NULL
);

-- One-time invitations for additional businesses (created by the platform admin).
CREATE TABLE business_invites (
  token_hash  TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  email       TEXT NOT NULL COLLATE NOCASE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash         TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  owner_id        TEXT NOT NULL REFERENCES owner_accounts(id),
  csrf_token      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  staff_id        TEXT,
  staff_epoch     INTEGER,
  staff_active_at INTEGER,
  reauth_at       INTEGER
);
CREATE INDEX idx_sessions_owner ON sessions(owner_id);
CREATE INDEX idx_sessions_staff ON sessions(staff_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE recovery_codes (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  owner_id    TEXT NOT NULL REFERENCES owner_accounts(id),
  code_hash   TEXT NOT NULL UNIQUE,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_recovery_owner ON recovery_codes(owner_id);

-- Sliding-window counters for login, PIN, recovery and admin attempts.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits ON rate_limits(key, at);

-- Business-entered rates. Rows are never updated; the newest row per metal is current.
CREATE TABLE rate_versions (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  metal           TEXT NOT NULL CHECK (metal IN ('gold','silver')),
  rate_paise      INTEGER NOT NULL CHECK (rate_paise > 0),
  created_by      TEXT NOT NULL REFERENCES staff(id),
  created_by_name TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_rates_current ON rate_versions(business_id, metal, created_at DESC);

CREATE TABLE order_counters (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  year        INTEGER NOT NULL,
  last_seq    INTEGER NOT NULL,
  PRIMARY KEY (business_id, year)
);

-- Photographs in R2. state: uploading -> pending -> attached.
-- Only uploading/pending rows older than the cleanup window are ever removed.
CREATE TABLE photos (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  r2_key       TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL CHECK (state IN ('uploading','pending','attached')),
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  uploaded_by  TEXT NOT NULL REFERENCES staff(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_photos_cleanup ON photos(state, created_at);
CREATE INDEX idx_photos_business ON photos(business_id);

CREATE TABLE quotes (
  id                 TEXT PRIMARY KEY,           -- immutable record id (also used for Google sync)
  business_id        TEXT NOT NULL REFERENCES businesses(id),
  order_no           TEXT NOT NULL,
  order_year         INTEGER NOT NULL,
  order_seq          INTEGER NOT NULL,
  idempotency_key    TEXT NOT NULL,
  draft_ref          TEXT NOT NULL,              -- printed on the photo before the order number exists
  staff_id           TEXT NOT NULL REFERENCES staff(id),
  staff_name         TEXT NOT NULL,
  customer_name      TEXT NOT NULL,
  customer_phone     TEXT NOT NULL,
  metal              TEXT NOT NULL CHECK (metal IN ('gold','silver')),
  item_type          TEXT NOT NULL,
  description        TEXT,
  purity             TEXT NOT NULL,
  gross_mg           INTEGER NOT NULL,
  deduction_mg       INTEGER NOT NULL,
  net_mg             INTEGER NOT NULL,
  rate_version_id    TEXT NOT NULL REFERENCES rate_versions(id),
  base_rate_paise    INTEGER NOT NULL,
  applied_rate_paise INTEGER NOT NULL,
  assessed_paise     INTEGER NOT NULL,
  pct_bp             INTEGER NOT NULL,
  offer_paise        INTEGER NOT NULL,
  pct_override       INTEGER NOT NULL DEFAULT 0,
  override_reason    TEXT,
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'estimated' CHECK (status IN ('estimated','accepted','cancelled')),
  photo_id           TEXT NOT NULL UNIQUE REFERENCES photos(id),
  original_json      TEXT NOT NULL,              -- snapshot of the quote exactly as first saved
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (business_id, order_no),
  UNIQUE (business_id, idempotency_key)
);
CREATE INDEX idx_quotes_recent ON quotes(business_id, created_at DESC);
CREATE INDEX idx_quotes_staff ON quotes(business_id, staff_id, created_at DESC);
CREATE INDEX idx_quotes_status ON quotes(business_id, status, created_at DESC);
CREATE INDEX idx_quotes_phone ON quotes(business_id, customer_phone);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  staff_id    TEXT,
  staff_name  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  reason      TEXT,
  before_json TEXT,
  after_json  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_business ON audit_log(business_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(business_id, entity_type, entity_id, created_at);

-- Google Drive / Sheets connection, one per business. Tokens are AES-GCM encrypted.
CREATE TABLE google_connections (
  business_id        TEXT PRIMARY KEY REFERENCES businesses(id),
  status             TEXT NOT NULL CHECK (status IN ('connected','reconnect_required','disconnected')),
  google_email       TEXT,
  scopes             TEXT,
  refresh_token_enc  TEXT,
  access_token_enc   TEXT,
  access_expires_at  INTEGER,
  connected_at       INTEGER,
  connected_by       TEXT,
  last_error         TEXT,
  drive_folder_id    TEXT,
  drive_folder_name  TEXT,
  spreadsheet_id     TEXT,
  spreadsheet_title  TEXT,
  sheet_id           INTEGER,
  sheet_title        TEXT,
  destinations_at    INTEGER,
  last_sync_at       INTEGER,
  sheet_lock_until   INTEGER,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  session_hash  TEXT NOT NULL,
  staff_id      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- Cached Drive sub-folders (year / month) under a business's backup folder.
CREATE TABLE drive_folders (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  root_id     TEXT NOT NULL,
  path        TEXT NOT NULL,
  folder_id   TEXT NOT NULL,
  PRIMARY KEY (business_id, root_id, path)
);

-- Durable synchronisation jobs. One row per (quote, kind). `version` goes up
-- whenever the record needs to be written again; the job is done when
-- synced_version = version.
CREATE TABLE sync_jobs (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id),
  quote_id        TEXT NOT NULL REFERENCES quotes(id),
  kind            TEXT NOT NULL CHECK (kind IN ('drive','sheet')),
  status          TEXT NOT NULL CHECK (status IN ('pending','synced','failed','paused')),
  version         INTEGER NOT NULL DEFAULT 1,
  synced_version  INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until     INTEGER,
  last_error      TEXT,
  drive_file_id   TEXT,
  drive_link      TEXT,
  spreadsheet_id  TEXT,
  sheet_id        INTEGER,
  sheet_row       INTEGER,
  synced_at       INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (quote_id, kind)
);
CREATE INDEX idx_sync_due ON sync_jobs(status, next_attempt_at);
CREATE INDEX idx_sync_business ON sync_jobs(business_id, status);
