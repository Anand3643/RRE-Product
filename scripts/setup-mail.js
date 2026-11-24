#!/usr/bin/env node
/**
 * RRE Entries — connects the Gmail account that sends sign-up confirmations, invitations and password-reset e-mails.
 *   npm run mail:setup
 * You type the Gmail address and the Google "App password" HERE (the password is hidden as you type). They are saved only in the
 * private .env file next to the application (never committed to Git), and a test e-mail is sent to prove they work.
 * Get an App password: turn on 2-Step Verification (https://myaccount.google.com/security), then create one at
 * https://myaccount.google.com/apppasswords (name it "RRE Entries"). Your normal Gmail password will not work.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ENV = path.resolve(__dirname, '..', '.env');

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = function (s) { if (s.includes(q) || /[\r\n]/.test(s)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}
function setVar(text, key, value) {
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(text) ? text.replace(re, () => `${key}=${value}`) : text.replace(/\s*$/, '\n') + `${key}=${value}\n`;
}
(async () => {
  const user = (process.env.RRE_SMTP_USER_INPUT || (await ask('Gmail address that will send the e-mails: '))).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(user)) { console.error('That is not a valid e-mail address.'); process.exit(1); }
  const pass = (process.env.RRE_SMTP_PASS_INPUT || (await ask('Google App password (16 characters, hidden): ', true))).replace(/\s+/g, '');
  if (pass.length < 12) { console.error('An App password is 16 characters. Create one at https://myaccount.google.com/apppasswords'); process.exit(1); }
  Object.assign(process.env, { RRE_SMTP_USER: user, RRE_SMTP_PASS: pass });
  const mailer = require('../core/mailer');
  console.log('Sending a test e-mail to ' + user + ' ...');
  const r = await mailer.send({ to: user, subject: 'RRE Entries e-mail test', text: 'This is a test from RRE Entries. If you can read it, sign-up confirmations, invitations and password resets will work.' });
  if (!r.sent) {
    const why = { authentication_failed: 'Gmail rejected the sign-in. Use a Google App password (not your normal password) and make sure 2-Step Verification is on.', unreachable: 'The mail server could not be reached. Check the internet connection.' }[r.reason] || 'The e-mail could not be sent (' + r.reason + ').';
    console.error('FAILED: ' + why + ' Nothing was saved.'); process.exit(2);
  }
  let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '# RRE Entries local settings (private, never committed)\n';
  text = setVar(setVar(text, 'RRE_SMTP_USER', user), 'RRE_SMTP_PASS', pass);
  fs.writeFileSync(ENV, text, { mode: 0o600 });
  console.log('Success. The test e-mail was sent and the settings were saved to .env. Restart RRE Entries to start using them.');
})().catch((e) => { console.error(e.message); process.exit(1); });
