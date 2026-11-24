/**
 * A tiny local SMTP server that accepts mail and keeps it in memory (for tests and local trials, never for real delivery).
 * Point RRE at it with RRE_SMTP_HOST=127.0.0.1 RRE_SMTP_PORT=<port> RRE_SMTP_TLS=0 RRE_SMTP_USER=x RRE_SMTP_PASS=y.
 */
const net = require('net');
function start(port = 0) {
  const inbox = [];
  const server = net.createServer((sock) => {
    let buf = '', data = null, authWait = false, cur = { from: '', to: [] };
    const send = (s) => sock.write(s + '\r\n');
    send('220 fake-smtp ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n'); if (end < 0) { return; }
          data = buf.slice(0, end); buf = buf.slice(end + 5);
          inbox.push({ from: cur.from, to: cur.to, raw: data }); data = null; cur = { from: '', to: [] }; send('250 queued'); continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2); const u = line.toUpperCase();
        if (authWait) { authWait = false; send('235 ok'); }
        else if (u.startsWith('EHLO')) { sock.write('250-fake-smtp\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n'); }
        else if (u.startsWith('HELO')) send('250 fake-smtp');
        else if (u.startsWith('AUTH PLAIN')) { if (line.trim().split(/s+/).length > 2) send('235 ok'); else { authWait = true; send('334 '); } }
        else if (u.startsWith('MAIL FROM')) { cur.from = line.slice(10).replace(/[<>]/g, '').trim().split(' ')[0]; send('250 ok'); }
        else if (u.startsWith('RCPT TO')) { cur.to.push(line.slice(8).replace(/[<>]/g, '').trim()); send('250 ok'); }
        else if (u === 'DATA') { data = ''; send('354 go'); }
        else if (u === 'QUIT') { send('221 bye'); sock.end(); return; }
        else send('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, inbox, close: () => server.close() })));
}
module.exports = { start };
if (require.main === module) start(parseInt(process.argv[2], 10) || 2525).then((s) => console.log('fake SMTP listening on 127.0.0.1:' + s.port));
