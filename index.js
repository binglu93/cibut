// /jamban/index.js
// Telegram bot (polling) + loader plugin + support sesi (+ auto-register user)
// Ditulis dan diupdate oleh (Julak Bantur)
// Bot ini disesuaikan dengan script local premium C1 by julak VPN
const datauser = require('./commands/datauser');
const { handleVpsPick } = require('./lib/addBaseWS');
const renewVmess = require('./commands/renewvmess');
const renewVless = require('./commands/renewvless');
const renewTrojan = require('./commands/renewtrojan');
const renewSSH = require('./commands/renewssh');
const trialsshPlugin = require('./commands/trialssh');
const trialvmessPlugin = require('./commands/trialvmess');
const trialvlessPlugin = require('./commands/trialvless');
const trialtrojanPlugin = require('./commands/trialtrojan');

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');

const botCommands = [
  trialsshPlugin,
  trialvmessPlugin,
  trialvlessPlugin,
  trialtrojanPlugin
];

const hapusPurchase = require('./commands/hapuspurchase');
botCommands.push(hapusPurchase);

// Simpan waktu start bot untuk perhitungan uptime
global.__BOT_STARTED_AT = Date.now();

// === QRIS CONFIG API ORDERKOUTA (jangan commit ke repo publik) ===
global.qrisConfig = {
  username: "username_orkut_anda",
  token: "token_qr_orkut_anda",
  baseurl: "https://url_api_anda",
  apikey: "apikey_anda",
  merchant: "code_merchant_orkut_anda",
  codeqr: "codeqr_orkut_anda"
};

// ===== Token bot: dari .env atau HardCode fallback =====
const HARDCODED_TOKEN = 'Token_bot_telegram_anda';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || HARDCODED_TOKEN;
if (!TOKEN || TOKEN === 'PUT_YOUR_BOT_TOKEN_HERE') {
  console.error('❌  Token tidak tersedia. Set .env TELEGRAM_BOT_TOKEN=... ATAU isi HARDCODED_TOKEN.');
  process.exit(1);
}

// === Owner helper (hardcode di lib/owner.js)
const { parseOwnerIds, isOwnerMsg } = require('./lib/owner');

// ====== DATABSAE SQLITE: wallet.db (daftarkan otomatis user ke database) ======
const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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

const stmtUpsertUser = db.prepare(`
  INSERT INTO users (tg_id, name, balance, created_at)
  VALUES (@tg_id, @name, 0, @created_at)
  ON CONFLICT(tg_id) DO UPDATE SET name = COALESCE(excluded.name, users.name)
`);

function fullName(u) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ')
      || u?.username
      || 'User';
}

function ensureUser(msg) {
  if (!msg?.from?.id) return;
  const tg_id = String(msg.from.id);
  const name  = fullName(msg.from);
  stmtUpsertUser.run({ tg_id, name, created_at: new Date().toISOString() });
}

// ====== BOT ======
const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅  Bot polling...');

// ===== Loader plugin =====
const COMMANDS_DIR = path.resolve(__dirname, 'commands');
const commandMap = new Map();
const aliasMap   = new Map();

function loadCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'));
  let count = 0;
  global.__registeredPlugins ??= Object.create(null);

  for (const file of files) {
    const full = path.join(COMMANDS_DIR, file);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);

      if (!mod?.name || typeof mod.execute !== 'function') {
        console.warn(`⚠️ Skip ${file} (tidak export {name, execute})`);
        continue;
      }

      const name = String(mod.name).toLowerCase();
      commandMap.set(name, mod);

      if (Array.isArray(mod.aliases)) {
        for (const a of mod.aliases) aliasMap.set(String(a).toLowerCase(), name);
      }

      count++;

      // Daftarkan plugin jika ada register()
      if (typeof mod.register === 'function' && !global.__registeredPlugins[name]) {
        try {
          mod.register(bot);
          global.__registeredPlugins[name] = true;
          console.log(`   ↳ registered: ${name}`);
        } catch (e) {
          console.error(`   ↳ register error (${name}):`, e?.message || e);
        }
      }
    } catch (e) {
      console.error(`❌ Upss Gagal load plugin ${file}:`, e?.message || e);
    }
  }

  console.log('🔌 Command termuat:', count);
}
loadCommands();

// ===== Pengurai Perintah (awalan "/" & ".") =====
function parseCommand(text = '') {
  const t = (text || '').trim();
  if (!t) return null;
  if (!(t.startsWith('/') || t.startsWith('.'))) return null;
  const cut = t.slice(1);
  const [cmdRaw, ...args] = cut.split(/\s+/);
  const base = String(cmdRaw || '').split('@')[0].toLowerCase();
  return { cmd: base, args };
}

// ===== Router utama =====
bot.on('message', async (msg) => {
  try {
    const text = msg.text ? msg.text.trim() : '';
    const isMedia = msg.photo || msg.document || msg.video;

    console.log(`[msg] chat:${msg.chat.id} from:${msg.from.id} @${msg.from.username || '-'}: ${text}`);
    
    if (commandMap.get('hapusakun')?.onMessage) {
    await commandMap.get('hapusakun').onMessage(bot, msg);
}
    // ====== Integrasi addserver.js ======
    const addserver = require('./commands/addserver');
    const handled = await addserver.handleMessage(bot, msg);
    if (handled) return;
    // ====== Integrasi broadcast.js ======
    const broadcast = require('./commands/broadcast');
    const handledBroadcast = await broadcast.handleMessage(bot, msg);
    if (handledBroadcast) return;
    // ====== Integrasi addsaldo.js ======
    const addsaldo = require('./commands/addsaldo');
    const handledAddSaldo = await addsaldo.handleMessage(bot, msg);
    if (handledAddSaldo) return;
    
        // ===== Integrasi datauser.js =====
    const handledDataUser = await datauser.execute(bot, msg);
    if (handledDataUser) return;

    // ===== Lanjutkan pesan teks untuk konfirmasi hapus user =====
    await datauser.continueHandler(bot, msg);

    // ===== COMMAND GLOBAL BATAL =====
    if (/^\/batal$/i.test(text)) {
      const { runCancelAllSessions } = require('./lib/cancel');
      runCancelAllSessions(bot);

      return bot.sendMessage(
        msg.chat.id,
        '✅ Semua proses berhasil dibatalkan sayang 💕'
      );
    }

    // COMMAND RELOAD (Hanya admin)
    if (/^\/reload$/i.test(text)) {
      if (!isOwnerMsg(msg)) return bot.sendMessage(msg.chat.id, '❌  Command ini hanya untuk owner.');
      for (const k of commandMap.keys()) commandMap.delete(k);
      for (const k of aliasMap.keys()) aliasMap.delete(k);
      loadCommands();
      return bot.sendMessage(msg.chat.id, '✅  Commands di-reload.');
    }

    // COMMAND PREFIX (misal /topupmanual, /approve)
    if (text.startsWith('/') || text.startsWith('.')) {
      const parsed = parseCommand(text);
      if (parsed) {
        const name = commandMap.has(parsed.cmd) ? parsed.cmd : aliasMap.get(parsed.cmd);
        if (!name) return;
        const plugin = commandMap.get(name);

        // === khusus /approve ===
        if (plugin?.approve && parsed.cmd === 'approve') {
          return await plugin.approve(bot, msg, parsed.args);
        }

        return await plugin.execute(bot, msg, parsed.args);
      }
    }

    // Teruskan pesan non-text ke plugin berbasis sesi
    const key = `${msg.chat.id}:${msg.from.id}`;
    for (const n of ['topupmanual', 'trialssh','trialvmess','trialvless','trialtrojan','renewssh',
                     'addssh','addvmess','addvless','addtrojan','renewvless',
                     'topup','ceksaldo','admin','renewvmess','renewtrojan','history','checkPendingTopup','deletevps',
                     'broadcast','addserver','addsaldo','datauser']) {
      const p = commandMap.get(n);
      if (p && typeof p.continue === 'function') {
        const handled = await p.continue(bot, msg);
        if (handled) return;
      }
    }

  } catch (e) {
    console.error('❌  Error handler:', e);
  }
});

// ==============================
// GLOBAL CALLBACK_QUERY HANDLER
// ==============================
bot.on('callback_query', async (query) => {
  const data = query.data || '';

  try {
    // 1) Jalankan onCallback milik plugin-plugin (jika ada)
    //    Jika salah satu plugin meng-handle -> hentikan iterasi untuk mencegah duplikasi.
    for (const plugin of botCommands) {
      if (plugin.onCallback) {
        try {
          const handled = await plugin.onCallback(bot, query);
          if (handled) {
            await bot.answerCallbackQuery(query.id).catch(()=>{});
            return;
          }
        } catch (e) {
          console.error('[plugin.onCallback error]', e);
        }
      }
    }
    
// callback_query hapus akun
if (commandMap.get('hapusakun')?.onCallback) {
    await commandMap.get('hapusakun').onCallback(bot, query);
}

// callback_query riwayat
if (commandMap.get('riwayat')?.onCallback) {
  const handled = await commandMap.get('riwayat').onCallback(bot, query);
  if (handled) {
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }
}

    // 2) Tombol BATAL universal
    if (data.endsWith(':cancel')) {
      const { runCancelAllSessions } = require('./lib/cancel');
      runCancelAllSessions(bot);
      await bot.answerCallbackQuery(query.id).catch(()=>{});
      await bot.editMessageText('❌ Proses dibatalkan.', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(()=>{});
      return;
    }

    // 3) Pilih VPS (menu trial/renew)
    if (await handleVpsPick(bot, query)) {
      await bot.answerCallbackQuery(query.id).catch(()=>{});
      return;
    }

    // 4) Handler kategori REPAIR tertentu
    if (data.startsWith('renewvmess:')) {
      await renewVmess.onCallbackQuery(bot, query);
      return;
    }
    if (data.startsWith('renewvless:')) {
      await renewVless.onCallbackQuery(bot, query);
      return;
    }
    if (data.startsWith('renewtrojan:')) {
      await renewTrojan.onCallbackQuery(bot, query);
      return;
    }
    if (data.startsWith('renewssh:')) {
      await renewSSH.onCallbackQuery(bot, query);
      return;
    }

    // 5) APPROVE TOPUP
    if (data.startsWith('approve:')) {
      const [ , userId, nominal, topupId ] = data.split(':');

      const adminId = String(query.from.id);
      if (adminId !== String(process.env.ADMIN_TG_ID)) {
        return bot.answerCallbackQuery(query.id, {
          text: '❌ Hanya admin yang bisa approve.',
          show_alert: true
        });
      }

      const topupManual = commandMap.get('topupmanual');
      if (topupManual && typeof topupManual.approve === 'function') {
      	const fakeMsg = {
      	  chat: { id: query.message.chat.id },
            from: { id: query.from.id }
          };
        await topupManual.approve(bot, fakeMsg, [userId, nominal, topupId]);
      }

      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );

      return bot.answerCallbackQuery(query.id, {
        text: `✅ Topup #${topupId} berhasil disetujui`
      });
    }

    // default: jawaban kosong (no-op)
    await bot.answerCallbackQuery(query.id).catch(() => {});
    
    // ===== Callback untuk DATAUSER =====
    const handledDataUser = await datauser.handleCallback(bot, query);
    if (handledDataUser) return;

    // default: jawaban kosong (no-op)
    await bot.answerCallbackQuery(query.id).catch(() => {});

  } catch (e) {
    console.error('[Callback Query Error]', e);
    await bot.answerCallbackQuery(query.id, { text: '❌ Terjadi error' }).catch(() => {});
  }
});

bot.onText(/^\/start$/i, async (msg) => {
  ensureUser(msg);
  const first = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
                || msg.from.username || 'teman';
});

bot.onText(/^\/help$/i, async (msg) => {
  ensureUser(msg);
  await bot.sendMessage(msg.chat.id, '• Ketik /menu — Untuk Menampilkan Menu Bot');
});

// ===== Info bot =====
bot.getMe()
  .then(me => {
    console.log(`🤖 Login sebagai @${me.username} (id: ${me.id})`);
    console.log('OWNER_ID(s):', parseOwnerIds().join(', '));
  })
  .catch(err => console.error('❌  getMe error:', err?.message || err));
