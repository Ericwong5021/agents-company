import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"

const authorizationLifetime = 10 * 60 * 1000

function now() {
  return new Date().toISOString()
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function equal(left: string, right: string) {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  return first.length === second.length && timingSafeEqual(first, second)
}

type AuthorizationRow = {
  id: string
  device_name: string
  code_hash: string
  status: "pending" | "approved" | "consumed"
  created_at: string
  expires_at: string
  device_id: string | null
}

type DeviceRow = {
  id: string
  name: string
  token_hash: string
  created_at: string
  revoked_at: string | null
}

export class RemoteStore {
  private database: Database
  private credentials = new Map<string, { device_id: string; device_name: string; device_token: string }>()

  constructor(readonly file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
    this.database = new Database(file, { create: true })
    this.database.exec("PRAGMA journal_mode = WAL")
    this.database.exec("PRAGMA foreign_keys = ON")
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS remote_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS remote_authorizations (
        id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        device_id TEXT,
        FOREIGN KEY(device_id) REFERENCES remote_devices(id)
      );
      CREATE TABLE IF NOT EXISTS remote_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
    `)
  }

  close() {
    this.database.close()
  }

  createAuthorization(deviceName: string) {
    const id = randomBytes(24).toString("base64url")
    const code = randomBytes(6).toString("base64url").toUpperCase()
    const createdAt = now()
    const expiresAt = new Date(Date.now() + authorizationLifetime).toISOString()
    this.database
      .query(
        "INSERT INTO remote_authorizations (id, device_name, code_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .run(id, deviceName.slice(0, 120), hash(code), createdAt, expiresAt)
    this.audit(id, "authorization_created")
    return { authorization_id: id, user_code: code, status: "pending" as const, expires_at: expiresAt }
  }

  authorization(id: string, code: string) {
    const row = this.database
      .query(
        "SELECT id, device_name, code_hash, status, created_at, expires_at, device_id FROM remote_authorizations WHERE id = ?",
      )
      .get(id) as AuthorizationRow | null
    if (!row || !equal(row.code_hash, hash(code))) return
    if (Date.parse(row.expires_at) <= Date.now()) return
    return { id: row.id, device_name: row.device_name, status: row.status, expires_at: row.expires_at }
  }

  approveAuthorization(id: string, code: string) {
    const current = this.authorization(id, code)
    if (!current || current.status !== "pending") throw new Error("authorization_unavailable")
    const deviceId = randomUUID()
    const deviceToken = randomBytes(32).toString("base64url")
    const createdAt = now()
    this.database.transaction(() => {
      this.database
        .query("INSERT INTO remote_devices (id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
        .run(deviceId, current.device_name, hash(deviceToken), createdAt)
      this.database
        .query(
          "UPDATE remote_authorizations SET status = 'approved', device_id = ? WHERE id = ? AND status = 'pending'",
        )
        .run(deviceId, id)
    })()
    this.credentials.set(id, { device_id: deviceId, device_name: current.device_name, device_token: deviceToken })
    this.audit(deviceId, "device_approved")
    return { device_id: deviceId, device_name: current.device_name }
  }

  consumeAuthorization(id: string, code: string) {
    const current = this.authorization(id, code)
    if (!current || current.status !== "approved") return
    const credential = this.credentials.get(id)
    if (!credential) throw new Error("authorization_restart_required")
    this.database
      .query("UPDATE remote_authorizations SET status = 'consumed' WHERE id = ? AND status = 'approved'")
      .run(id)
    this.credentials.delete(id)
    this.audit(credential.device_id, "device_token_consumed")
    return credential
  }

  deviceForToken(id: string, token: string) {
    const row = this.database
      .query(
        "SELECT id, name, token_hash, created_at, revoked_at FROM remote_devices WHERE id = ? AND revoked_at IS NULL",
      )
      .get(id) as DeviceRow | null
    if (!row || !equal(row.token_hash, hash(token))) return
    return { id: row.id, name: row.name, created_at: row.created_at }
  }

  revokeDevice(id: string) {
    const result = this.database
      .query("UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now(), id)
    if (!result.changes) throw new Error("device_not_found")
    this.audit(id, "device_revoked")
  }

  devices() {
    return (
      this.database
        .query("SELECT id, name, created_at, revoked_at FROM remote_devices ORDER BY created_at DESC")
        .all() as Array<Pick<DeviceRow, "id" | "name" | "created_at" | "revoked_at">>
    ).map((row) => ({ id: row.id, name: row.name, created_at: row.created_at, revoked_at: row.revoked_at }))
  }

  audit(actor: string, event: string, detail?: string) {
    this.database
      .query("INSERT INTO remote_audit (actor, event, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(actor, event, detail ?? null, now())
  }

  tables() {
    return (
      this.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  }
}
