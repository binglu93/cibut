// lib/renewBase.js
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');
const { logPurchase } = require('../lib/db');

// ===== sqlite wallet =====
const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
function openDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id TEXT PRIMARY KEY,
      name  TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
const db = openDB();
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (tg_id, name, balance, created_at)
  VALUES (@tg_id, @name, 0, @created_at)
  ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name
`);
const stmtGetUser    = db.prepare(`SELECT tg_id,name,balance FROM users WHERE tg_id=?`);
const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`);

// ===== utils =====
const skey     = (msg) => `${msg.chat?.id}:${msg.from?.id}`;
const textOf   = (msg) => String(msg.text || msg.caption || '').trim();
const send     = (bot, chatId, text, opt={}) => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opt });
const fullname = (u)=>[u?.first_name,u?.last_name].filter(Boolean).join(' ')||u?.username||'User';
const idr      = (n)=> Number(n||0).toLocaleString('id-ID');

function ensureUserSqlite(msg) {
  const tg_id = String(msg.from.id);
  const name  = fullname(msg.from);
  stmtUpsertUser.run({ tg_id, name, created_at: new Date().toISOString() });
  return stmtGetUser.get(tg_id);
}

function stripAnsi(s='') { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

function loadVpsList() {
  const p = path.resolve(process.cwd(), 'julak', 'vps.json');
  if (!fs.existsSync(p)) throw new Error('Server tidak ditemukan.');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data Server kosong/tidak valid.');
  return data;
}

function listVpsButtons(arr, name) {
  return arr.map((v, i) => {
    const nama = v.id || `${v.host}:${v.port || 22}`;
    const harga = v.harga_per_hari ? `Rp${idr(v.harga_per_hari)}/hari` : 'Rp0/hari';
    return [{
      text: `${nama} (${harga})`,
      callback_data: `${name}:pickvps:${i}`
    }];
  });
}

// ============ VALIDASI USER SSH =============
//
// SSH user HARUS ada di /etc/passwd (atau shadow).
// Kita cukup cek keberadaan user lokal, tidak pakai marker.
//
function validateSSHUser(username, vps) {
  return new Promise((resolve) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(`getent passwd ${username}`, (err, stream) => {
        if (err) {
          conn.end();
          resolve({ ok:false, msg: "Gagal membaca database user di VPS." });
          return;
        }

        let output = "";
        stream.on("data", d => output += d.toString());
        stream.on("close", () => {
          conn.end();
          if (output.trim().length > 0) {
            resolve({ ok:true });
          } else {
            resolve({ ok:false, msg:`User SSH ${username} tidak ditemukan di VPS.` });
          }
        });
      });
    });

    conn.on('error', e => {
      resolve({ ok:false, msg:`SSH Error: ${e.message}` });
    });

    conn.connect({
      host: vps.host,
      port: vps.port || 22,
      username: vps.username,
      password: vps.password
    });
  });
}


// SSH EXECUTOR
function sshRun(vps, shellCmd, headerText, bot, msg) {
  return new Promise((resolve) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(shellCmd, (err, stream) => {
        if (err) {
          send(bot, msg.chat.id, '❌ Gagal menjalankan perintah di VPS.').catch(()=>{});
          conn.end(); return resolve();
        }
        let out = '';
        stream.on('data', (c)=> out += c.toString());
        stream.stderr.on('data', (c)=> out += c.toString());
        stream.on('close', async () => {
          const clean = stripAnsi(out).trim();
          await send(bot, msg.chat.id, `${headerText}\n\n${clean || '(output kosong)'}`).catch(()=>{});
          conn.end(); resolve();
        });
      });
    });
    conn.on('error', (e)=>{ send(bot, msg.chat.id, `❌ SSH Error: ${e?.message||e}`).catch(()=>{}); resolve(); });
    conn.connect({ host: vps.host, port: vps.port||22, username: vps.username, password: vps.password });
  });
}


// ========== PLUGIN UTAMA ==========
function createRenewPlugin({ name, aliases=[], title, commandTpl }) {

  global.__renewssh_sessions ??= Object.create(null);

  // START
  async function start(bot, msg) {
    const key = `${name}:${skey(msg)}`;

    let vpsList;
    try { vpsList = loadVpsList(); }
    catch (e) { return send(bot, msg.chat.id, `❌ ${e.message}`); }

    ensureUserSqlite(msg);

    global.__renewssh_sessions[key] = {
      step: 1, 
      vpsList,
      promptedForUsername: false
    };

    const buttons = listVpsButtons(vpsList, name);
    buttons.push([{ text: '🔙 Batal', callback_data: `${name}:cancel` }]);

    await bot.sendMessage(msg.chat.id, `*${title}*\n\nPilih server:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });

    setTimeout(() => {
      const S = global.__renewssh_sessions[key];
      if (S && S.step === 1) {
        delete global.__renewssh_sessions[key];
        send(bot, msg.chat.id, '⏳ Sesi dihapus karena tidak ada interaksi 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  // CONTINUE
  async function cont(bot, msg) {
    const key = `${name}:${skey(msg)}`;
    const S = global.__renewssh_sessions[key];
    if (!S) return false;

    const t = textOf(msg);
    if (/^([./])?batal$/i.test(t)) {
      delete global.__renewssh_sessions[key];
      await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
      return true;
    }

    // === Step 2: username ===
    if (S.step === 2) {
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username SSH tidak valid. 3–32 karakter.');
        return true;
      }

      S.user = t;

      // VALIDASI SSH USER
      await send(bot, msg.chat.id, '⏳ Mengecek user SSH di VPS...');
      const check = await validateSSHUser(S.user, S.vps);
      if (!check.ok) {
        await send(bot, msg.chat.id, `❌ ${check.msg}\nSaldo tidak terpotong.`);
        delete global.__renewssh_sessions[key];
        return true;
      }

      S.step = 3;
      await send(bot, msg.chat.id, '⏳ Masukkan *Masa Aktif (hari)*:\n\nKlik /batal untuk membatalkan');
      return true;
    }

    // === Step 3: durasi ===
    if (S.step === 3) {
      const days = parseInt(t, 10);
      if (isNaN(days) || days <= 0 || days > 3650) {
        await send(bot, msg.chat.id, '⚠️ Hari tidak valid (1–3650).');
        return true;
      }

      const hargaPerHari = Number(S.vps?.harga_per_hari || 0);
      const cost = days * hargaPerHari;
      const u = ensureUserSqlite(msg);
      if (u.balance < cost) {
        await send(bot, msg.chat.id, `💸 Saldo tidak cukup.\nHarga: Rp${idr(cost)}\nSaldo: Rp${idr(u.balance)}`);
        delete global.__renewssh_sessions[key];
        return true;
      }

      // Potong saldo
      const tx = db.transaction(()=>{ stmtAddBalance.run(-cost, String(msg.from.id)); });
      tx();

      const exp = days.toString();
      const cmd = commandTpl.replaceAll('{USER}', S.user).replaceAll('{EXP}', exp);

      delete global.__renewssh_sessions[key];

      await send(bot, msg.chat.id,
        `⏳ Menjalankan ${title}...\n• User: ${S.user}\n• Durasi: ${days} hari\n• Harga: Rp${idr(cost)}`
      );

      await sshRun(S.vps, cmd, `✅ ${title} berhasil!`, bot, msg);

      try {
        logPurchase({
          tg_id: msg.from.id,
          kind: "renew-ssh",
          days,
          vps_id: S.vps?.id || S.vps.host
        });
      } catch(e){}

      return true;
    }

    return true;
  }

  // CALLBACK
  async function onCallbackQuery(bot, query) {
    const msg = query.message;
    const userId = query.from.id;

    const startKey = `${name}:${msg.chat.id}:${userId}`;
    const sk = `${name}:${skey(msg)}`;

    const S = global.__renewssh_sessions[startKey] || global.__renewssh_sessions[sk];
    if (!S) {
      await bot.answerCallbackQuery(query.id, { text: 'Sesi tidak ditemukan.' });
      return false;
    }

    const data = query.data;

    if (data === `${name}:cancel`) {
      delete global.__renewssh_sessions[sk];
      delete global.__renewssh_sessions[startKey];
      await bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
      await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
      return true;
    }

    const parts = String(data).split(':');
    if (parts[0] !== name || parts[1] !== 'pickvps') return false;

    const idx = parseInt(parts[2], 10);
    if (isNaN(idx) || idx < 0 || idx >= S.vpsList.length) {
      await bot.answerCallbackQuery(query.id, { text: 'Pilihan tidak valid.' });
      return false;
    }

    if (S.step === 2 && S.promptedForUsername) {
      await bot.answerCallbackQuery(query.id, { text: 'Server sudah dipilih.' });
      return true;
    }

    S.vps = S.vpsList[idx];
    S.step = 2;
    S.promptedForUsername = true;

    await bot.answerCallbackQuery(query.id, { text: 'Server dipilih.' });

    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
    } catch(e){}

    await bot.sendMessage(msg.chat.id,
      '👤 Masukkan *username SSH* yang akan diperpanjang:\n\nKlik /batal untuk membatalkan',
      { parse_mode: 'Markdown' }
    );

    return true;
  }

  return {
    name,
    aliases,
    description: `${title} (SSH renew)`,
    execute: start,
    continue: cont,
    onCallbackQuery
  };
}

module.exports = { createRenewPlugin };
