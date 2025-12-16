// command/hapusakun.js
const { exec } = require('child_process');
const path = require('path');

// 🟦 Ambil semua VPS dari /julak/vps.json
const VPS_LIST = require('../julak/vps.json');

// 🟦 Map jenis → script lokal
const SCRIPT_MAP = {
  ssh: "/usr/local/sbin/bot-delssh",
  vmess: "/usr/local/sbin/bot-del-vmess",
  vless: "/usr/local/sbin/bot-delvless",
  trojan: "/usr/local/sbin/bot-del-trojan"
};

// 🟥 State session
const sessions = {};

module.exports = {
  name: "hapusakun",

  // ============================
  // /hapusakun (command utama)
  // ============================
  async execute(bot, msg) {
    const chatId = msg.chat.id;
    const adminId = String(msg.from.id);
    const MASTER = String(process.env.ADMIN_TG_ID);

    if (adminId !== MASTER) {
      return bot.sendMessage(chatId, "❌ Kamu tidak punya akses.");
    }

    sessions[adminId] = { step: "pick_server" };

    return bot.sendMessage(
      chatId,
      "🖥 <b>Pilih server tempat akun berada:</b>",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            ...VPS_LIST.map(v => [
              { text: v.id, callback_data: `hapusakun_server_${v.id}` }
            ]),
            [{ text: "❌ Batal", callback_data: "hapusakun_cancel" }]
          ]
        }
      }
    );
  },

  // ============================
  // Callback Handler
  // ============================
  async onCallback(bot, query) {
    const data = query.data;
    const userId = String(query.from.id);
    const chatId = query.message.chat.id;

    const MASTER = String(process.env.ADMIN_TG_ID);
    if (userId !== MASTER) return;

    sessions[userId] = sessions[userId] || {};

    // ❌ BATAL
    if (data === "hapusakun_cancel") {
      delete sessions[userId];
      await bot.editMessageText("❌ Dibatalkan.", {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return;
    }

    // 🟦 Pilih server
    if (data.startsWith("hapusakun_server_")) {
      const serverId = data.replace("hapusakun_server_", "");
      sessions[userId].serverId = serverId;
      sessions[userId].step = "pick_type";

      return bot.editMessageText(
        `📡 <b>Server dipilih:</b> ${serverId}\n\nPilih jenis akun yang ingin dihapus:`,
        {
          parse_mode: "HTML",
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "SSH", callback_data: "hapusakun_type_ssh" },
                { text: "VMESS", callback_data: "hapusakun_type_vmess" }
              ],
              [
                { text: "VLESS", callback_data: "hapusakun_type_vless" },
                { text: "TROJAN", callback_data: "hapusakun_type_trojan" }
              ],
              [{ text: "❌ Batal", callback_data: "hapusakun_cancel" }]
            ]
          }
        }
      );
    }

    // 🟦 Pilih jenis akun
    if (data.startsWith("hapusakun_type_")) {
      const type = data.replace("hapusakun_type_", "");

      sessions[userId].type = type;
      sessions[userId].step = "input_username";

      await bot.editMessageText(
        `⚙️ <b>Hapus akun ${type.toUpperCase()}</b>\n\nSilakan kirim username yang ingin dihapus:`,
        {
          parse_mode: "HTML",
          chat_id: chatId,
          message_id: query.message.message_id
        }
      );

      return;
    }
  },

  // ============================
  // Input username via message
  // ============================
  async onMessage(bot, msg) {
    const userId = String(msg.from.id);
    const text = msg.text?.trim();
    const chatId = msg.chat.id;

    const MASTER = String(process.env.ADMIN_TG_ID);
    if (userId !== MASTER) return;

    const session = sessions[userId];
    if (!session || session.step !== "input_username") return;

    const username = text;
    const type = session.type;
    const serverId = session.serverId;
    const script = SCRIPT_MAP[type];

    delete sessions[userId];

    if (!script) {
      return bot.sendMessage(chatId, "❌ Script untuk jenis tersebut tidak ditemukan.");
    }

    bot.sendMessage(
      chatId,
      `⏳ Menghapus akun <b>${username}</b> di server <b>${serverId}</b>...`,
      { parse_mode: "HTML" }
    );

    // 🔥 Jalankan script local + FILTER OUTPUT
    exec(`${script} ${username}`, (err, stdout, stderr) => {
      const out = (stdout || "").trim();
      const errOut = (stderr || "").trim();

      // ❌ ERROR dari exec
      if (err) {
        return bot.sendMessage(
          chatId,
          `❌ <b>Gagal menjalankan script</b>\n<code>${err.message}</code>`,
          { parse_mode: "HTML" }
        );
      }

      // ❌ Kalau script bilang username tidak ada
      if (out.toLowerCase().includes("not found") || errOut.toLowerCase().includes("not found")) {
        return bot.sendMessage(
          chatId,
          `❌ <b>Username tidak ditemukan</b>\n👤 <code>${username}</code>`,
          { parse_mode: "HTML" }
        );
      }

      // ❌ Kalau script output kosong → kemungkinan salah user
      if (out === "" && errOut === "") {
        return bot.sendMessage(
          chatId,
          `❌ <b>Script tidak memberikan respon</b>\nCek kembali username atau script del kamu.`,
          { parse_mode: "HTML" }
        );
      }

      // ❌ Kalau script kirim "error"
      if (out.toLowerCase().includes("error") || errOut.toLowerCase().includes("error")) {
        return bot.sendMessage(
          chatId,
          `❌ <b>Error dari script</b>\n<code>${out || errOut}</code>`,
          { parse_mode: "HTML" }
        );
      }

      // ✔ Jika ada kata sukses
      if (out.toLowerCase().includes("deleted") || out.toLowerCase().includes("success")) {
        return bot.sendMessage(
          chatId,
          `✅ <b>Akun berhasil dihapus</b>\n\n` +
          `👤 Username: <code>${username}</code>\n` +
          `📦 Jenis: <b>${type.toUpperCase()}</b>\n` +
          `🖥 Server: <b>${serverId}</b>`,
          { parse_mode: "HTML" }
        );
      }

      // ✔ Fallback (jika script output normal tanpa keyword)
      bot.sendMessage(
        chatId,
        `✅ <b>Akun dihapus</b>\n\n<code>${out}</code>`,
        { parse_mode: "HTML" }
      );
    });
  }
};
