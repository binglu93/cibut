// lib/cancel.js
// Fungsi universal untuk membatalkan semua sesi
// Ditulis dan diupdate oleh (Julak Bantur)
// Bot ini dibuat dan disesuaikan untuk autoscript C1 by Julak VPN

function runCancelAllSessions(bot) {
  // 1) Hapus semua sesi dari modul session
  try {
    const { clearAllSessions } = require('./session');
    if (typeof clearAllSessions === 'function') {
      clearAllSessions(bot);
    }
  } catch (e) {
    console.error('cancel.js error clearAllSessions:', e);
  }

  // 2) Hapus semua global session custom
  const globalSessions = [
    '__addssh_sessions',
    '__addws_sessions',
    '__renewssh_sessions',
    '__renewvm_sessions',
    '__admin_sessions',
    '__trial_sessions'
  ];

  for (const name of globalSessions) {
    if (global[name]) {
      try {
        if (typeof global[name].clear === 'function') {
          global[name].clear();
        } else if (typeof global[name] === 'object') {
          for (const key in global[name]) delete global[name][key];
        }
      } catch (e) {
        console.error(`Error wiping global session ${name}:`, e);
      }

      global[name] = {};
    }
  }
}

module.exports = { runCancelAllSessions };
