import { DatabaseSync, type StatementSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { generateToken, hashToken, safeEqual } from "./tokens.js"

export type Db = DatabaseSync

export interface UserRow {
  id: number
  username: string
  password_hash: string
  totp_secret: string | null
  totp_enabled: number
  created_at: number
  updated_at: number
}

export interface SessionRow {
  id: number
  user_id: number
  token_hash: string
  kind: "web" | "bot"
  created_at: number
  last_seen_at: number
  expires_at: number
  user_agent: string | null
  ip: string | null
  /**
   * Denormalised from users.username on read.
   *
   * Populated by a JOIN, not stored: the schema deliberately has no
   * `username` column here, and anything reading it must not silently get
   * `undefined` and render as a blank name.
   */
  username?: string
}

export interface BotTokenRow {
  id: number
  user_id: number
  token_hash: string
  label: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

/**
 * node:sqlite hands back untyped records. These wrappers contain the single
 * unavoidable cast in one place instead of scattering `as unknown as` across
 * every query.
 */
function one<T>(stmt: StatementSync, ...params: Array<string | number | null>): T | undefined {
  return stmt.get(...params) as unknown as T | undefined
}

function many<T>(stmt: StatementSync, ...params: Array<string | number | null>): T[] {
  return stmt.all(...params) as unknown as T[]
}

function run(stmt: StatementSync, ...params: Array<string | number | null>): number {
  return Number(stmt.run(...params).changes)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT    NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL DEFAULT 'web',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_hash    ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS bot_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bot_tokens_hash ON bot_tokens(token_hash);
`

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  if (path !== ":memory:") {
    // WAL lets readers proceed during writes. NORMAL is the right durability
    // trade for a single-user app where losing the last few ms of session
    // writes would be harmless.
    db.exec("PRAGMA journal_mode = WAL")
  }
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)
  return db
}

// ── users ────────────────────────────────────────────────────────────────────

export function getUser(db: Db): UserRow | undefined {
  return one<UserRow>(db.prepare("SELECT * FROM users WHERE id = 1"))
}

export function userExists(db: Db): boolean {
  return one<{ present: number }>(db.prepare("SELECT 1 AS present FROM users WHERE id = 1"))?.present === 1
}

export function createUser(db: Db, username: string, passwordHash: string, totpSecret: string | null): UserRow {
  const now = Date.now()
  db.prepare(
    `INSERT INTO users (id, username, password_hash, totp_secret, totp_enabled, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
  ).run(username, passwordHash, totpSecret, totpSecret ? 1 : 0, now, now)
  return getUser(db)!
}

export function setPasswordHash(db: Db, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = 1").run(passwordHash, Date.now())
}

export function setTotp(db: Db, secret: string | null): void {
  db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = ?, updated_at = ? WHERE id = 1").run(
    secret,
    secret ? 1 : 0,
    Date.now(),
  )
}

export function getTotpEnabled(db: Db): boolean {
  return one<{ totp_enabled: number }>(db.prepare("SELECT totp_enabled FROM users WHERE id = 1"))?.totp_enabled === 1
}

// ── recovery codes ───────────────────────────────────────────────────────────

export function replaceRecoveryCodes(db: Db, codeHashes: string[]): void {
  db.exec("DELETE FROM recovery_codes")
  const stmt = db.prepare("INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (1, ?, ?)")
  const now = Date.now()
  for (const h of codeHashes) stmt.run(h, now)
}

export function consumeRecoveryCode(db: Db, code: string): boolean {
  const target = hashToken(code.trim().toUpperCase())
  const rows = many<{ id: number; code_hash: string }>(
    db.prepare("SELECT id, code_hash FROM recovery_codes WHERE user_id = 1 AND used_at IS NULL"),
  )
  // Recovery codes are short and low-entropy, so compare every candidate rather
  // than stopping at the first match.
  const match = rows.find((r) => safeEqual(r.code_hash, target))
  if (!match) return false
  db.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ?").run(Date.now(), match.id)
  return true
}

export function unusedRecoveryCodeCount(db: Db): number {
  return one<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL"))?.n ?? 0
}

// ── sessions ─────────────────────────────────────────────────────────────────

export interface IssuedSession {
  row: SessionRow
  /** Plaintext token. Returned once, never stored, never logged. */
  token: string
}

export function createSession(
  db: Db,
  ttlMs: number,
  meta: { userAgent?: string | null; ip?: string | null; kind?: "web" | "bot" } = {},
): IssuedSession {
  const token = generateToken(32)
  const now = Date.now()
  const res = db
    .prepare(
      `INSERT INTO sessions (user_id, token_hash, kind, created_at, last_seen_at, expires_at, user_agent, ip)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(hashToken(token), meta.kind ?? "web", now, now, now + ttlMs, meta.userAgent ?? null, meta.ip ?? null)
  const row = one<SessionRow>(db.prepare("SELECT * FROM sessions WHERE id = ?"), Number(res.lastInsertRowid))!
  return { row, token }
}

/**
 * The one place a session is loaded for authentication.
 *
 * JOINs users.username in so callers get the account name with the session,
 * rather than a row with no name on it that renders as a blank user in the UI.
 */
export function findSessionByToken(db: Db, token: string): SessionRow | undefined {
  return one<SessionRow>(
    db.prepare(
      `SELECT s.*, u.username AS username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    ),
    hashToken(token),
  )
}

/**
 * Slide the expiry forward, but only once the stored value is stale enough to
 * be worth a disk write. Without this guard every SSE frame would hit the DB.
 */
export function touchSession(db: Db, id: number, ttlMs: number, slideIntervalMs: number): SessionRow | undefined {
  // JOINs users for the same reason as findSessionByToken: this is the row that
  // actually reaches the request, so selecting without the username here means
  // req.session.username is undefined everywhere downstream.
  const row = one<SessionRow>(
    db.prepare(
      `SELECT s.*, u.username AS username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    ),
    id,
  )
  if (!row) return undefined
  const now = Date.now()
  if (now - row.last_seen_at >= slideIntervalMs) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(now, now + ttlMs, id)
    row.last_seen_at = now
    row.expires_at = now + ttlMs
  }
  return row
}

export function revokeSession(db: Db, id: number): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
}

export function revokeAllSessions(db: Db): number {
  return run(db.prepare("DELETE FROM sessions WHERE user_id = 1"))
}

export function listSessions(db: Db): SessionRow[] {
  return many<SessionRow>(
    db.prepare("SELECT * FROM sessions WHERE user_id = 1 AND expires_at > ? ORDER BY last_seen_at DESC"),
    Date.now(),
  )
}

export function purgeExpiredSessions(db: Db): number {
  return run(db.prepare("DELETE FROM sessions WHERE expires_at <= ?"), Date.now())
}

// ── bot tokens ───────────────────────────────────────────────────────────────

export function createBotToken(db: Db, label: string): { row: BotTokenRow; token: string } {
  const token = `ocm_${generateToken(32)}`
  const res = db
    .prepare("INSERT INTO bot_tokens (user_id, token_hash, label, created_at) VALUES (1, ?, ?, ?)")
    .run(hashToken(token), label, Date.now())
  const row = one<BotTokenRow>(db.prepare("SELECT * FROM bot_tokens WHERE id = ?"), Number(res.lastInsertRowid))!
  return { row, token }
}

export function findBotToken(db: Db, token: string): BotTokenRow | undefined {
  return one<BotTokenRow>(
    db.prepare("SELECT * FROM bot_tokens WHERE token_hash = ? AND revoked_at IS NULL"),
    hashToken(token),
  )
}

export function touchBotToken(db: Db, id: number): void {
  db.prepare("UPDATE bot_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), id)
}

export function revokeBotToken(db: Db, id: number): void {
  db.prepare("UPDATE bot_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id)
}

export function listBotTokens(db: Db): BotTokenRow[] {
  return many<BotTokenRow>(db.prepare("SELECT * FROM bot_tokens WHERE user_id = 1 ORDER BY created_at DESC"))
}
