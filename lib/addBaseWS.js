// lib/addBaseWS.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');
const { logPurchase } = require('../lib/db');

// const HARGA_PER_HARI = Number(process.env.HARGA_PER_HARI || 200);

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
  if (!fs.existsSync(p)) throw new Error('File Server tidak ditemukan.');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data VPS kosong/tidak valid.');
  return data;
}

// ===== hitung akun GLOBAL (XRAY + SSH) per VPS =====
async function countGlobalAccounts(vps) {
  const cmd = `
    # ===== XRAY =====
    if [ -f /etc/xray/config.json ]; then
      VMESS=$(grep -c '^###' /etc/xray/config.json || true)
      VLESS=$(grep -c '^#&'  /etc/xray/config.json || true)
      TROJAN=$(grep -c '^#!' /etc/xray/config.json || true)
    else
      VMESS=0; VLESS=0; TROJAN=0
    fi

    # ===== SSH (exclude system users) =====
    SSH=$(awk -F: '$3 >= 1000 && $1 !~ /^(nobody)$/ {print $1}' /etc/passwd | wc -l)

    echo "$VMESS $VLESS $TROJAN $SSH"
  `;

  return new Promise((resolve) => {
    const conn = new Client();
    let output = '';

    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return resolve({
            ssh: 0, vmess: 0, vless: 0, trojan: 0, total: 0
          });
        }

        stream.on('data', d => output += d.toString());
        stream.on('close', () => {
          conn.end();

          const [vmess, vless, trojan, ssh] = output
            .trim()
            .split(/\s+/)
            .map(n => parseInt(n, 10) || 0);

          resolve({
            ssh,
            vmess,
            vless,
            trojan,
            total: ssh + vmess + vless + trojan
          });
        });
      });
    });

    conn.on('error', () =>
      resolve({ ssh:0, vmess:0, vless:0, trojan:0, total:0 })
    );

    conn.connect({
      host: vps.host,
      port: vps.port || 22,
      username: vps.username,
      password: vps.password
    });
  });
}

// === tampilkan daftar server dengan tombol (versi estetis + batal) ===
async function promptPickVps(bot, msg, title, protocol = 'vmess') {
  const vpsList = loadVpsList();
  let listText = '📋 *List Server:*\n\n';
  const keyboard = [];

  for (let i = 0; i < vpsList.length; i++) {
    const v = vpsList[i];
    const vpsId = v.id || v.host;

    const used = await countGlobalAccounts(v);
    const totalUsed = used.total;
    const limit = Number(v.limit_add || 0);
    const harga = Number(v.harga_per_hari || 0);

    // opsional (kalau ada)
    const quota = v.limit_quota || null;
    const ipLimit = v.limit_ip || null;

    const full = limit > 0 && totalUsed >= limit;

    listText +=
`┏━ 🚀 *${vpsId}* ━━
┃ 💰 Harga per hari : Rp${harga.toLocaleString()}
${quota ? `┃ 📦 Limit Quota  : ${quota} GB\n` : ''}${ipLimit ? `┃ 🔒 Limit IP     : ${ipLimit} IP\n` : ''}${
  full
    ? '┃ ⚠️ *Server Penuh*\n'
    : `┃ 👥 Total Akun   : ${totalUsed}/${limit || '∞'}\n`
}┗━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    keyboard.push([{
      text: full
        ? `❌ ${vpsId} (Penuh)`
        : `${vpsId} • Rp${harga}/hari`,
      callback_data: `pickvps:${i}${full ? ':full' : ''}`
    }]);
  }

  // tombol batal (paling bawah)
  keyboard.push([{
    text: '❌ Batal',
    callback_data: 'pickvps:batal'
  }]);

  await bot.sendMessage(
    msg.chat.id,
    `${title}\n\n${listText}Pilih salah satu Server :`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );

  return vpsList;
}

// === eksekusi SSH command ===
function sshRun(vps, shellCmd, headerText, bot, msg, opts = {}) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    const timer = opts.timeoutMs ? setTimeout(() => {
      if (!finished) {
        finished = true;
        try { conn.end(); } catch(e) {}
        resolve({ ok: false, reason: 'timeout', stdout: '', stderr: 'SSH timeout' });
      }
    }, opts.timeoutMs) : null;

    conn.on('ready', () => {
      conn.exec(shellCmd, (err, stream) => {
        if (err) {
          if (timer) clearTimeout(timer);
          finished = true;
          send(bot, msg.chat.id, '❌ Gagal menjalankan perintah di VPS.').catch(()=>{});
          conn.end();
          return resolve({ ok: false, reason: 'exec_error', stdout: '', stderr: String(err) });
        }
        let out = '';
        let errOut = '';
        stream.on('data', (c)=> out += c.toString());
        stream.stderr.on('data', (c)=> errOut += c.toString());
        stream.on('close', async (code, signal) => {
          if (timer) clearTimeout(timer);
          finished = true;
          const clean = stripAnsi((out + '\n' + errOut).trim());
          if (headerText) {
            await send(bot, msg.chat.id, `${headerText}\n\n${clean || '(output kosong)'}`).catch(()=>{});
          }
          conn.end();
          resolve({ ok: true, code: typeof code==='number'?code:null, stdout: out, stderr: errOut, combined: clean });
        });
      });
    });
    conn.on('error', (e)=>{ 
      if (timer) clearTimeout(timer);
      if (!finished) {
        finished = true;
        send(bot, msg.chat.id, `❌ SSH Error: ${e?.message||e}`).catch(()=>{});
        resolve({ ok: false, reason: 'conn_error', stdout:'', stderr: String(e) });
      }
    });
    conn.connect({ host: vps.host, port: vps.port||22, username: vps.username, password: vps.password });
  });
}

// === callback tombol pilih server (sinkron limit XRAY) ===
async function handleVpsPick(bot, query) {
  const data = query.data;
// ❌ tombol batal
if (data === 'pickvps:batal') {
  const key = Object.keys(global.__addws_sessions || {}).find(k =>
    k.endsWith(`:${query.from.id}`)
  );

  if (key) delete global.__addws_sessions[key];

  await bot.answerCallbackQuery(query.id, {
    text: '❌ Sesi dibatalkan',
    show_alert: false
  });

  await bot.sendMessage(
    query.message.chat.id,
    '✅ Proses dibatalkan.'
  );

  return true;
}
  if (!data.startsWith('pickvps:')) return false;

  // 🚫 cegah klik server penuh
  if (data.endsWith(':full')) {
    await bot.answerCallbackQuery(query.id, {
      text: '⚠️ Server ini sudah penuh, silakan pilih server lain.',
      show_alert: true
    });
    return true;
  }

  const idx = parseInt(data.split(':')[1], 10);

  // cari session aktif (step 1)
  const key = Object.keys(global.__addws_sessions || {}).find(k => {
    const s = global.__addws_sessions[k];
    return s && s.step === 1 && k.endsWith(`:${query.from.id}`);
  });

  if (!key) {
    await bot.answerCallbackQuery(query.id, {
      text: '⚠️ Sesi tidak ditemukan atau sudah kadaluarsa.',
      show_alert: true
    });
    return true;
  }

  const S = global.__addws_sessions[key];

  if (!S?.vpsList?.[idx]) {
    await bot.answerCallbackQuery(query.id, {
      text: '❌ Server tidak ditemukan.',
      show_alert: true
    });
    return true;
  }

  // 🚫 cegah double klik
  if (S.step !== 1) {
    await bot.answerCallbackQuery(query.id, {
      text: '⚠️ Server sudah dipilih sebelumnya.'
    });
    return true;
  }

  // simpan VPS terpilih
  S.vps = S.vpsList[idx];
  S.step = 2;

  await bot.answerCallbackQuery(query.id, {
    text: `✅ Server dipilih: ${S.vps.id || S.vps.host}`
  });

  await bot.sendMessage(
    query.message.chat.id,
    '👤 Masukkan *username*:',
    { parse_mode: 'Markdown' }
  );

  return true;
}

// === Plugin utama ===
function createAddWsPlugin({ name, aliases=[], title, commandTpl, expMode='days' }) {
  global.__addws_sessions ??= Object.create(null);
  
  function daysToExpStr(days){
    if(expMode==='date'){
      const d = new Date(); d.setDate(d.getDate()+days);
      const pad = n=>String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    }
    return String(days);
  }

  async function start(bot, msg){
    const key = `${name}:${skey(msg)}`;
    let vpsList;
    try{ vpsList = await promptPickVps(bot, msg, `*${title}*`); }
    catch(e){ return send(bot, msg.chat.id, `❌ ${e.message||e}`); }

    ensureUserSqlite(msg);
    global.__addws_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      const S = global.__addws_sessions[key];
      if (S && S.step === 1) {
        delete global.__addws_sessions[key];
        send(bot, msg.chat.id, '⏳ Session Expired.').catch(()=>{});
      }
    }, 60_000);
  }

  async function cont(bot, msg){
    const key = `${name}:${skey(msg)}`;
    const S = global.__addws_sessions[key];
    const t = textOf(msg);
    if (!S) return false;

    if (/^([./])?batal$/i.test(t)) {
      delete global.__addws_sessions[key];
      await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
      return true;
    }

    if (S.step === 1) {
      await send(bot, msg.chat.id, '⚠️ Silakan pilih server lewat tombol, bukan mengetik.');
      return true;
    }

    if (S.step === 2) {
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username harus 3–32 char (huruf/angka/_ . -). Coba lagi.');
        return true;
      }
      S.user = t;
      S.step = 3;
      await send(bot, msg.chat.id, '⏳ Masukkan *Masa Aktif (hari)*:');
      return true;
    }

    if (S.step === 3) {
      const days = parseInt(t, 10);
      if (isNaN(days) || days <= 0 || days > 3650) {
        await send(bot, msg.chat.id, '⚠️ Hari tidak valid (1–3650). Coba lagi.');
        return true;
      }

      // ambil harga dari VPS (fallback ke hargaPerHari jika ada)
      const hargaServer = Number(S.vps?.harga_per_hari || hargaPerHari || 0);
      if (!hargaServer || hargaServer <= 0) {
         await send(bot, msg.chat.id, '❌ Harga server belum diatur');
         delete global.__addws_sessions[key];
         return true;
       }

      const cost = days * hargaServer;
      const u = ensureUserSqlite(msg);
      const saldoBefore = u?.balance || 0;

      if (saldoBefore < cost) {
        const kurang = cost - saldoBefore;
        await send(
          bot,
          msg.chat.id,
          `💸 *Saldo tidak cukup*.\n` +
          `• Harga: Rp${idr(cost)}\n` +
          `• Saldo: Rp${idr(saldoBefore)}\n` +
          `• Kurang: *Rp${idr(kurang)}*`
        );
        delete global.__addws_sessions[key];
        return true;
      }
      
// ✅ cek limit per VPS (GLOBAL: SSH + XRAY)
const vpsId = S.vps?.id || S.vps?.host;
const limit = Number(S.vps?.limit_add || 0);

if (limit > 0) {
  const used = await countGlobalAccounts(S.vps);

  if (used.total >= limit) {
    await send(
      bot,
      msg.chat.id,
      `⚠️ VPS ${vpsId} sudah mencapai limit ${limit} akun.\n\n` +
      `📊 Detail penggunaan:\n` +
      `• SSH   : ${used.ssh}\n` +
      `• VMESS : ${used.vmess}\n` +
      `• VLESS : ${used.vless}\n` +
      `• TROJAN: ${used.trojan}\n` +
      `• TOTAL : ${used.total}/${limit}\n\n` +
      `Silakan pilih server lain 🙏`
    );

    delete global.__addws_sessions[key];
    return true;
  }
}

      const expStr = daysToExpStr(days);
      const cmd = commandTpl
        .replaceAll('{USER}', S.user)
        .replaceAll('{EXP}',  expStr);

      await send(bot,msg.chat.id,`⏳ Membuat ${title} di VPS ${S.vps.id||S.vps.host}\n• Username: ${S.user}\n• Durasi: ${days} hari\n• Total Harga: Rp${idr(cost)}\n• Saldo sebelum: Rp${idr(saldoBefore)}`);

      const res = await sshRun(S.vps,cmd,'',bot,msg,{timeoutMs:20000});
      if(!res.ok){
        await send(bot,msg.chat.id,`❌ Gagal membuat ${title}. Saldo tidak dipotong.\nReason: ${res.reason || 'unknown'}`);
        delete global.__addws_sessions[key]; return true;
      }

      // cek error
      const combined = String(res.combined||'').toLowerCase();
      const exitCode = res.code;
      const failPatterns = ['no such file','not found','command not found','permission denied','error','failed'];
      const exitCodeFailed = exitCode!==null && exitCode!==0;
      const matchedFail = failPatterns.some(p=>combined.includes(p));
      if(exitCodeFailed||matchedFail){
        await send(bot,msg.chat.id,`❌ Gagal membuat ${title}. Output:\n${res.combined||'(no output)'}\nSaldo tidak dipotong.`);
        delete global.__addws_sessions[key]; return true;
      }

      // sukses -> potong saldo
      db.transaction(()=>{ stmtAddBalance.run(-cost,String(msg.from.id)) })();
      const saldoAfter = saldoBefore - cost;
      delete global.__addws_sessions[key];

      await send(bot,msg.chat.id,`✅ ${title} berhasil dibuat !\n\n${res.combined||'(no output)'}`);

      try{ logPurchase({ tg_id: msg.from.id, kind:'vmess', days, vps_id: S.vps?.id||S.vps?.host }); }
      catch(e){ console.error('[logPurchase SSH]',e?.message||e); }

      return true;
    }

    return true;
  }

  return {
    name,
    aliases,
    description: `${title} (pakai saldo, harga per hari sesuai VPS)`,
    async execute(bot,msg){ return start(bot,msg); },
    async continue(bot,msg){ return cont(bot,msg); },
    handleVpsPick
  };
}

module.exports = { createAddWsPlugin, handleVpsPick };
