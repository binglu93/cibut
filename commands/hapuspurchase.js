// command/hapuspurchase.js
const db = require('../lib/db').db;

module.exports = {
  name: "hapuspurchase",

  async execute(bot, msg) {
    const chatId = msg.chat.id;
    const adminId = msg.from.id;

    const ADMINS = process.env.ADMIN_TG_ID;
    if (!ADMINS.includes(adminId)) {
      return bot.sendMessage(chatId, "❌ Kamu tidak punya akses.");
    }

    return sendPage(bot, chatId, 0);
  },

  // =============== CALLBACK HANDLER ===============
  async onCallback(bot, query) {
    const data = query.data;
    const chatId = query.message.chat.id;

    // Filter: callback untuk fitur ini saja
    if (!data.startsWith("hapuspl_")) return false;

    // tombol batal
    if (data === "hapuspl_cancel") {
      await bot.editMessageText("❌ Dibatalkan.", {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return bot.answerCallbackQuery(query.id);
    }

    // tombol next
    if (data.startsWith("hapuspl_next_")) {
      const current = Number(data.split("_")[2]);
      await sendPage(bot, chatId, current + 1, query.message.message_id);
      return bot.answerCallbackQuery(query.id);
    }

    // tombol prev
    if (data.startsWith("hapuspl_prev_")) {
      const current = Number(data.split("_")[2]);
      await sendPage(bot, chatId, current - 1, query.message.message_id);
      return bot.answerCallbackQuery(query.id);
    }

    // tombol hapus data
    if (data.startsWith("hapuspl_delete_")) {
      const logId = Number(data.split("_")[2]);

      db.prepare(`DELETE FROM purchase_logs WHERE id = ?`).run(logId);

      await bot.answerCallbackQuery(query.id, {
        text: `🗑️ LogID ${logId} dihapus.`,
        show_alert: false
      });

      // refresh halaman
      return sendPage(bot, chatId, 0, query.message.message_id);
    }

    return bot.answerCallbackQuery(query.id);
  }
};

// =====================================================
// =============== Pagination Function =================
// =====================================================

async function sendPage(bot, chatId, page = 0, messageId = null) {
  const limit = 10;
  const offset = page * limit;

  const rows = db.prepare(`
    SELECT id, tg_id, kind, vps_id, days, created_at
    FROM purchase_logs
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as n FROM purchase_logs`).get().n;
  const maxPage = Math.ceil(total / limit) - 1;

  if (rows.length === 0) {
    return bot.sendMessage(chatId, "⚠️ Tidak ada data pembelian.");
  }

  let text = `🧾 <b>Daftar Pembelian (Page ${page + 1})</b>\n\n`;
  rows.forEach(r => {
    text += `🆔 LogID: <code>${r.id}</code>\n`;
    text += `👤 User: <code>${r.tg_id}</code>\n`;
    text += `📦 Jenis: ${r.kind}\n`;
    if (r.vps_id) text += `🖥 VPS: ${r.vps_id}\n`;
    if (r.days) text += `⏳ Durasi: ${r.days} hari\n`;
    text += `🕒 ${r.created_at}\n`;
    text += `──────────────\n`;
  });

  let buttons = [];

  rows.forEach(r => {
    buttons.push([
      {
        text: `🗑️ Hapus LogID ${r.id}`,
        callback_data: `hapuspl_delete_${r.id}`
      }
    ]);
  });

  let nav = [];
  if (page > 0) nav.push({ text: "⬅️ Prev", callback_data: `hapuspl_prev_${page}` });
  if (page < maxPage) nav.push({ text: "➡️ Next", callback_data: `hapuspl_next_${page}` });
  nav.push({ text: "❌ Batal", callback_data: "hapuspl_cancel" });

  buttons.push(nav);

  const opts = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  };

  if (messageId) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...opts
    });
  }

  return bot.sendMessage(chatId, text, opts);
}
