// commands/riwayat.js
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const OWNER_ID = process.env.OWNER_ID
  ? Number(process.env.OWNER_ID)
  : null;

const db = new Database(path.resolve(process.cwd(), 'julak', 'wallet.db'), {});

// 🟦 Auto create table jika belum ada
db.exec(`
CREATE TABLE IF NOT EXISTS purchase_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  days INTEGER,
  vps_id TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
`);

function esc(v) {
  if (v === null || v === undefined) return '-';
  return String(v).replace(/([_*[\]()~`>#+\\|{}.!-])/g, '\\$1');
}

const PAGE_SIZE = 1;

module.exports = {
  name: "riwayat",

  async execute(bot, msg, args) {
    const userId = String(msg.from.id);
    const isAdmin = Number(userId) === OWNER_ID;

    const page = 1;
    const offset = 0;

    let rows;
    let total;

    if (isAdmin) {
      rows = db.prepare(`
        SELECT p.*, (SELECT name FROM users WHERE tg_id = p.tg_id) AS name
        FROM purchase_logs p
        ORDER BY datetime(p.created_at) DESC
        LIMIT ? OFFSET ?
      `).all(PAGE_SIZE, offset);

      total = db.prepare(`SELECT COUNT(*) AS c FROM purchase_logs`).get().c;

    } else {
      rows = db.prepare(`
        SELECT *
        FROM purchase_logs
        WHERE tg_id = ?
        ORDER BY datetime(created_at) DESC
        LIMIT ? OFFSET ?
      `).all(userId, PAGE_SIZE, offset);

      total = db.prepare(`
        SELECT COUNT(*) AS c FROM purchase_logs WHERE tg_id = ?
      `).get(userId).c;
    }

    if (rows.length === 0) {
      return bot.sendMessage(msg.chat.id,
        isAdmin ? "Belum ada transaksi." : "Kamu belum memiliki riwayat transaksi."
      );
    }

    const text = buildPageText(rows, page, total, isAdmin);

    const keyboard = buildKeyboard(page, total, isAdmin, userId);

    return bot.sendMessage(msg.chat.id, text, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard
    });
  },

  // ============================================
  // CALLBACK HANDLER
  // ============================================
  async onCallback(bot, query) {
    const data = query.data || "";
    if (!data.startsWith("riwayat:")) return false;

    const parts = data.split(":"); 
    // riwayat:page:userId
    const page = Number(parts[1]);
    const userIdTarget = parts[2];
    const isAdmin = Number(query.from.id) === OWNER_ID;

    const PAGE = page < 1 ? 1 : page;
    const offset = (PAGE - 1) * PAGE_SIZE;

    let rows;
    let total;

    if (isAdmin) {
      rows = db.prepare(`
        SELECT p.*, (SELECT name FROM users WHERE tg_id = p.tg_id) AS name
        FROM purchase_logs p
        ORDER BY datetime(p.created_at) DESC
        LIMIT ? OFFSET ?
      `).all(PAGE_SIZE, offset);

      total = db.prepare(`SELECT COUNT(*) AS c FROM purchase_logs`).get().c;

    } else {
      rows = db.prepare(`
        SELECT *
        FROM purchase_logs
        WHERE tg_id = ?
        ORDER BY datetime(created_at) DESC
        LIMIT ? OFFSET ?
      `).all(userIdTarget, PAGE_SIZE, offset);

      total = db.prepare(`
        SELECT COUNT(*) AS c FROM purchase_logs WHERE tg_id = ?
      `).get(userIdTarget).c;
    }

    const text = buildPageText(rows, PAGE, total, isAdmin);
    const keyboard = buildKeyboard(PAGE, total, isAdmin, userIdTarget);

    await bot.editMessageText(text, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "MarkdownV2",
      reply_markup: keyboard
    }).catch(()=>{});

    return true;
  }
};

// ===============================
// UTIL: Format halaman
// ===============================
function buildPageText(rows, page, total, isAdmin) {
  let teks = isAdmin
    ? "*📜 Riwayat Transaksi Semua User*\n\n"
    : "*📜 Riwayat Transaksi Kamu*\n\n";

  for (const r of rows) {
    const meta = r.meta ? esc(JSON.stringify(JSON.parse(r.meta), null, 2)) : "-";

    teks +=
`🆔 ID Log: *${esc(r.id)}*
${isAdmin ? `👤 User: *${esc(r.name || r.tg_id)}*\n` : ""}
🔧 Jenis: *${esc(r.kind)}*
⏳ Durasi: *${esc(r.days || 0)} hari*
🖥 VPS: *${esc(r.vps_id || "-")}*
🕒 Waktu: *${esc(r.created_at)}*
`;
  }

  teks += `*Halaman:* ${page} / ${Math.ceil(total / PAGE_SIZE)}`;

  return teks;
}

// ===============================
// UTIL: Keyboard Next/Prev
// ===============================
function buildKeyboard(page, total, isAdmin, userIdTarget) {
  const maxPage = Math.ceil(total / PAGE_SIZE);

  const buttons = [];

  const prev = page > 1
    ? { text: "⬅️ Prev", callback_data: `riwayat:${page - 1}:${userIdTarget}` }
    : null;

  const next = page < maxPage
    ? { text: "Next ➡️", callback_data: `riwayat:${page + 1}:${userIdTarget}` }
    : null;

  const row = [];
  if (prev) row.push(prev);
  if (next) row.push(next);

  // === Tambahkan tombol Kembali ===
  const backRow = [
    { text: "🔙 Kembali", callback_data: "menu:open" }
  ];

  if (row.length) {
    return { inline_keyboard: [row, backRow] };
  } else {
    return { inline_keyboard: [backRow] };
  }
}
