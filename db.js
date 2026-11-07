'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id            INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      guardian_name TEXT,
      phone         TEXT NOT NULL,
      alt_phone     TEXT,
      email         TEXT,
      dob           TEXT,
      address       TEXT,
      id_type       TEXT,
      id_number     TEXT,
      id_type_2     TEXT,
      id_number_2   TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

    CREATE TABLE IF NOT EXISTS loans (
      id              INTEGER PRIMARY KEY,
      loan_no         TEXT UNIQUE,
      customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      principal       REAL NOT NULL,
      interest_rate   REAL NOT NULL,          -- % per month, simple interest
      start_date      TEXT NOT NULL,          -- YYYY-MM-DD
      due_date        TEXT,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
      closed_date     TEXT,
      collateral_type TEXT,
      collateral_desc TEXT,
      gold_weight_g   REAL,
      gold_purity     TEXT,
      notes           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_loans_customer ON loans(customer_id);

    CREATE TABLE IF NOT EXISTS payments (
      id         INTEGER PRIMARY KEY,
      loan_id    INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
      paid_on    TEXT NOT NULL,
      amount     REAL NOT NULL,
      mode       TEXT,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_loan ON payments(loan_id);
  `);
  return db;
}

module.exports = { openDb };
