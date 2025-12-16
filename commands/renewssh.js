const { createRenewPlugin } = require('../lib/renewBase');

module.exports = createRenewPlugin({
  name: 'renewssh',
  aliases: ['renew-ssh'],
  title: 'Perpanjang Akun SSH',
  commandTpl: '/usr/local/sbin/bot-extssh {USER} {EXP}',
  expMode: 'days',
  marker: 'SSH'
});
