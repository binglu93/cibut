// commands/datauser.js
// ==================================================
// Admin Data User — Advanced plugin node-telegram-bot-api (compatible execute)
// ==================================================

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.resolve(process.cwd(), 'julak', 'wallet.db'));

const adminSession = new Map(); // sesi interaktif admin
const PAGE_SIZE = 10;

// === CONFIG OWNER ===
function isOwner(msg) {
  const ownerEnv = process.env.ADMIN_TG_ID;
  if (!ownerEnv) return true;
  return msg?.from?.id === parseInt(ownerEnv, 10);
}

// === DB Helper ===
function getUsersPage(offset = 0, limit = PAGE_SIZE) {
  return db.prepare('SELECT tg_id, name, balance, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function getUser(tg_id) {
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tg_id);
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
}

function deleteUser(tg_id) {
  return db.prepare('DELETE FROM users WHERE tg_id = ?').run(tg_id);
}

function resetSaldo(tg_id) {
  return db.prepare('UPDATE users SET balance = 0 WHERE tg_id = ?').run(tg_id);
}

// === HANDLE /datauser MESSAGE ===
async function handleMessage(bot, msg) {
  if (!isOwner(msg)) return false;
  const text = msg.text ? msg.text.trim() : '';
  if (text !== '/datauser') return false;

  return sendUserList(bot, msg.from.id, 0); // mulai dari halaman 0
}

// === SEND USER LIST DENGAN PAGINATION ===
async function sendUserList(bot, userId, page = 0, messageId = null) {
  const offset = page * PAGE_SIZE;
  const users = getUsersPage(offset);
  const total = countUsers();
  if (users.length === 0) {
    await bot.sendMessage(userId, '📭 Belum ada user di database.');
    return true;
  }

  const inline_keyboard = users.map((u) => [
    { text: `${u.name || u.tg_id} (Rp${u.balance})`, callback_data: `datauser_view_${u.tg_id}` },
  ]);

  // Tombol navigasi
  const navButtons = [];
  if (page > 0) navButtons.push({ text: '⬅️ Prev', callback_data: `datauser_page_${page - 1}` });
  if ((offset + PAGE_SIZE) < total) navButtons.push({ text: 'Next ➡️', callback_data: `datauser_page_${page + 1}` });
  if (navButtons.length) inline_keyboard.push(navButtons);

  const textMsg = `👥 *Daftar User (${total})*\nHalaman ${page + 1} / ${Math.ceil(total / PAGE_SIZE)}`;
  const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard } };

  if (messageId) {
    await bot.editMessageText(textMsg, { chat_id: userId, message_id: messageId, ...options });
  } else {
    await bot.sendMessage(userId, textMsg, options);
  }
  return true;
}

// === HANDLE CALLBACK QUERY ===
async function handleCallback(bot, query) {
  const data = query.data;
  const fromId = query.from.id;
  if (!isOwner(query)) return false;

  if (data.startsWith('datauser_view_')) return showUserDetail(bot, query);
  if (data.startsWith('datauser_reset_')) return resetUserSaldo(bot, query);
  if (data.startsWith('datauser_delete_')) return confirmDeleteUser(bot, query);
  if (data.startsWith('datauser_page_')) return changePage(bot, query);
  if (data === 'datauser_back') return backToUserList(bot, query);

  return false;
}

// === DETAIL USER ===
async function showUserDetail(bot, query) {
  const tg_id = query.data.replace('datauser_view_', '');
  const u = getUser(tg_id);
  if (!u) {
    await bot.answerCallbackQuery(query.id, { text: 'User tidak ditemukan', show_alert: true });
    return true;
  }

  const inline_keyboard = [
    [
      { text: '🧾 Reset Saldo', callback_data: `datauser_reset_${tg_id}` },
      { text: '🗑️ Hapus User', callback_data: `datauser_delete_${tg_id}` },
    ],
    [{ text: '⬅️ Kembali', callback_data: 'datauser_back' }],
  ];

  const info = `👤 *Detail User*\n\n🆔 ID: \`${u.tg_id}\`\n📛 Nama: ${u.name || '-'}\n💰 Saldo: Rp${u.balance}\n🕒 Dibuat: ${u.created_at}`;
  await bot.editMessageText(info, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard },
  });
  return true;
}

// === RESET SALDO ===
async function resetUserSaldo(bot, query) {
  const tg_id = query.data.replace('datauser_reset_', '');
  resetSaldo(tg_id);
  await bot.answerCallbackQuery(query.id, { text: 'Saldo direset ✅' });
  await bot.sendMessage(query.from.id, `💰 Saldo user \`${tg_id}\` telah direset ke 0.`, { parse_mode: 'Markdown' });
  return true;
}

// === KONFIRMASI HAPUS USER ===
async function confirmDeleteUser(bot, query) {
  const tg_id = query.data.replace('datauser_delete_', '');
  adminSession.set(query.from.id, { step: 'confirm_delete', targetId: tg_id });
  await bot.sendMessage(query.from.id, `⚠️ Ketik *ya* untuk konfirmasi hapus user \`${tg_id}\`.`, { parse_mode: 'Markdown' });
  return true;
}

// === CHANGE PAGE ===
async function changePage(bot, query) {
  const page = parseInt(query.data.replace('datauser_page_', ''), 10);
  await sendUserList(bot, query.from.id, page, query.message.message_id);
  await bot.answerCallbackQuery(query.id);
  return true;
}

// === KEMBALI KE LIST DARI DETAIL ===
async function backToUserList(bot, query) {
  await sendUserList(bot, query.from.id, 0, query.message.message_id);
  return true;
}

// === LANJUTAN (Konfirmasi Hapus via Teks) ===
async function continueHandler(bot, msg) {
  const userId = msg.from.id;
  const text = msg.text ? msg.text.trim().toLowerCase() : '';
  const session = adminSession.get(userId);
  if (!session) return false;

  if (session.step === 'confirm_delete') {
    if (text === 'ya') {
      deleteUser(session.targetId);
      await bot.sendMessage(userId, `🗑️ User \`${session.targetId}\` berhasil dihapus.`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(userId, '❎ Dibatalkan.');
    }
    adminSession.delete(userId);
    return true;
  }

  return false;
}

// === EXECUTE (alias handleMessage) supaya compatible loader ===
async function execute(bot, msg) {
  return handleMessage(bot, msg);
}

// === EXPORT ===
module.exports = {
  name: 'datauser',
  execute,           // wajib ada untuk loader
  handleCallback,
  continueHandler,
};
