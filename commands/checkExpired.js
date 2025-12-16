// commands/checkExpired.js
// ===============================================================
// Auto Check Expired Users
// Bisa jalan otomatis tiap hari tanpa command /cekexpired
// ===============================================================

const Database = require('better-sqlite3');
const path = require('path');
const { Client } = require('ssh2');
const fs = require('fs');

// ========== OPEN DATABASE ==========
const db = new Database(path.resolve(process.cwd(), 'julak', 'wallet.db'));
db.pragma('journal_mode = WAL');

const stmtActive = db.prepare(`
  SELECT *
  FROM purchase_logs
`);

const stmtDeleteLog = db.prepare(`DELETE FROM purchase_logs WHERE id=?`);

// ========== LOAD VPS LIST ==========
function loadVpsList() {
  const p = path.resolve(process.cwd(), 'julak', 'vps.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function getVpsById(id) {
  const list = loadVpsList();
  return list.find(v => v.id === id || v.host === id);
}

// ========== SSH RUN SIMPLE ==========
function sshRunSimple(vps, cmd) {
  return new Promise(resolve => {
    const conn = new Client();
    let output = '';

    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); return resolve(false); }
        stream.on('data', c => output += c.toString());
        stream.on('close', () => { conn.end(); resolve(output); });
      });
    });

    conn.on('error', () => resolve(false));

    conn.connect({
      host: vps.host,
      port: vps.port || 22,
      username: vps.username,
      password: vps.password,
    });
  });
}

// ========== CEK EXPIRED ==========
function isExpired(createdAt, days) {
  const start = new Date(createdAt);
  const expired = new Date(start.getTime() + days * 86400 * 1000);
  return new Date() > expired;
}

async function runCheckExpired(bot, notifyAdmin = true) {
  const logs = stmtActive.all();
  if (!logs.length) return 0;

  let removed = 0;

  for (const row of logs) {
    if (!isExpired(row.created_at, row.days)) continue;

    const vps = getVpsById(row.vps_id);
    if (!vps) continue;

    const delCmd = `userdel -f ${row.username} 2>/dev/null || true`;
    await sshRunSimple(vps, delCmd);

    stmtDeleteLog.run(row.id);
    removed++;
  }

  // Kirim notifikasi ke admin (opsional)
  if (notifyAdmin && bot) {
    const adminId = Number(process.env.ADMIN_TG_ID || 0);
    if (adminId) {
      await bot.sendMessage(
        adminId,
        `✅ [AutoCheck] Selesai.\nAkun expired yang dihapus: *${removed}*`,
        { parse_mode: 'Markdown' }
      ).catch(()=>{});
    }
  }

  return removed;
}

// ===============================================================
// EXPORT COMMAND PLUGIN
// ===============================================================
module.exports = {
  name: "cekexpired",
  async execute(bot, msg) {
    const adminId = Number(process.env.ADMIN_TG_ID || 0);
    if (msg && msg.from && msg.from.id !== adminId) {
      return bot.sendMessage(msg.chat.id, "🚫 Kamu bukan admin.");
    }

    if (msg) await bot.sendMessage(msg.chat.id, "⏳ Mengecek akun expired...");

    const removed = await runCheckExpired(bot);

    if (msg) {
      return bot.sendMessage(
        msg.chat.id,
        `✅ Selesai.\nAkun expired yang dihapus: *${removed}*`,
        { parse_mode: 'Markdown' }
      );
    }
  },

  // fungsi tambahan supaya bisa dipanggil dari scheduler
  runCheckExpired
};

// ========== AUTO SCHEDULER ==========
// Panggil ini di bot utama sekali saja saat startup
// Jalankan tiap 24 jam
module.exports.startAutoScheduler = function(bot) {
  setInterval(async () => {
    try {
      await runCheckExpired(bot, true);
    } catch (e) {
      console.error('[AutoCheckExpired]', e);
    }
  }, 24 * 60 * 60 * 1000); // 24 jam
};
