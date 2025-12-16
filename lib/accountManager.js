// lib/accountManager.js
// System B — account manager (cross-protocol) for purchase_logs
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ===================================================================
// 1) Patch DB: tambahkan kolom yang dibutuhkan jika belum ada
// ===================================================================
function patchDB() {
  const cols = db.prepare(`PRAGMA table_info(purchase_logs)`).all().map(r => r.name);
  try {
    if (!cols.includes('username')) {
      db.prepare(`ALTER TABLE purchase_logs ADD COLUMN username TEXT`).run();
    }
  } catch (e) { /* ignore if already exists */ }

  try {
    if (!cols.includes('expired_at')) {
      db.prepare(`ALTER TABLE purchase_logs ADD COLUMN expired_at TEXT`).run();
    }
  } catch (e) { /* ignore */ }

  try {
    if (!cols.includes('is_active')) {
      db.prepare(`ALTER TABLE purchase_logs ADD COLUMN is_active INTEGER DEFAULT 1`).run();
    }
  } catch (e) { /* ignore */ }
}
patchDB();

// ===================================================================
// 2) Utility: format date (yyyy-mm-dd) from now + days
// ===================================================================
function toExpiryDate(days) {
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ===================================================================
// 3) Save account purchase (tidak menghapus history jika sudah ada)
//    - tg_id, kind, vps_id, username, days, expired_at, meta (json), is_active
// ===================================================================
const stmtInsert = db.prepare(`
  INSERT INTO purchase_logs
    (tg_id, kind, days, vps_id, meta, username, expired_at, is_active, created_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
`);

function saveAccount({ tg_id, kind, vps_id, username, days = null, expired_at = null, meta = null }) {
  // expired_at boleh dalam bentuk yyyy-mm-dd atau timestamp; kita simpan apa adanya
  return stmtInsert.run(
    String(tg_id),
    String(kind || ''),
    days === null ? null : Number(days),
    vps_id === undefined ? null : String(vps_id),
    meta ? JSON.stringify(meta) : null,
    username === undefined ? null : String(username),
    expired_at === undefined || expired_at === null ? null : String(expired_at)
  );
}

// ===================================================================
// 4) Count aktif per VPS (hanya is_active = 1)
// ===================================================================
const stmtCountActive = db.prepare(`
  SELECT COUNT(*) AS total FROM purchase_logs
  WHERE vps_id = ? AND is_active = 1 AND (expired_at IS NULL OR expired_at >= ?)
`);

function countActiveAccountsByVps(vpsId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = stmtCountActive.get(String(vpsId), today);
  return row?.total || 0;
}

// ===================================================================
// 5) Mark expired -> set is_active = 0 untuk expired_at < today
// ===================================================================
const stmtMarkExpired = db.prepare(`
  UPDATE purchase_logs
  SET is_active = 0
  WHERE is_active = 1 AND expired_at IS NOT NULL AND expired_at < ?
`);

function markExpiredAccounts() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtMarkExpired.run(today);
}

// ===================================================================
// 6) Optional: delete expired rows (if kamu mau benar-benar bersih)
// ===================================================================
const stmtDeleteExpired = db.prepare(`
  DELETE FROM purchase_logs
  WHERE expired_at IS NOT NULL AND expired_at < ?
`);

function deleteExpiredAccounts() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtDeleteExpired.run(today);
}

// ===================================================================
// 7) Exports
// ===================================================================
module.exports = {
  db,
  patchDB,
  toExpiryDate,
  saveAccount,
  countActiveAccountsByVps,
  markExpiredAccounts,
  deleteExpiredAccounts
};
