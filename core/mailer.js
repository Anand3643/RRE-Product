/**
 * RRE Entries — sends e-mail (password-reset links, account invitations, confirmations) through Gmail SMTP.
 *
 * Configuration comes ONLY from environment variables (see .env.example):
 *   RRE_SMTP_USER   the Gmail address that sends the mail
 *   RRE_SMTP_PASS   a Google "App password" (NOT the normal Gmail password)
 *   RRE_SMTP_HOST   default smtp.gmail.com        RRE_SMTP_PORT   default 465 (SSL; 587 uses STARTTLS)
 *   RRE_MAIL_FROM   default "RRE Entries <RRE_SMTP_USER>"
 *   RRE_PUBLIC_URL  the address people open RRE at, used in links (default http://127.0.0.1:<port>)
 * Nothing here is ever stored in the database, sent to the browser, or written to a log.
 */
let transport = null; // injected by tests
let cached = null;

const cfg = () => ({
  user: (process.env.RRE_SMTP_USER || '').trim(),
  pass: process.env.RRE_SMTP_PASS || '',
  host: (process.env.RRE_SMTP_HOST || 'smtp.gmail.com').trim(),
  port: parseInt(process.env.RRE_SMTP_PORT || '465', 10) || 465,
  from: (process.env.RRE_MAIL_FROM || '').trim()
});
const isConfigured = () => { const c = cfg(); return !!(transport || (c.user && c.pass)); };

function getTransport() {
  if (transport) return transport;
  const c = cfg();
  const key = `${c.host}|${c.port}|${c.user}`;
  if (cached && cached.key === key) return cached.t;
  const nodemailer = require('nodemailer');
  const secure = c.port === 465, plain = process.env.RRE_SMTP_TLS === '0'; // RRE_SMTP_TLS=0 is for a local mail relay / test catcher only
  const t = nodemailer.createTransport({
    host: c.host, port: c.port, secure: plain ? false : secure, requireTLS: plain ? false : !secure, ignoreTLS: plain, auth: { user: c.user, pass: c.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
  });
  cached = { key, t };
  return t;
}

function publicUrl(port) {
  const u = (process.env.RRE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return u || `http://127.0.0.1:${port || process.env.PORT || 4000}`;
}

/** @returns {{sent:boolean, reason?:string}} never throws, never includes credentials */
async function send({ to, subject, text, html }) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const c = cfg();
  try {
    await getTransport().sendMail({ from: c.from || `RRE Entries <${c.user || 'no-reply@localhost'}>`, to, subject, text, html });
    return { sent: true };
  } catch (e) {
    const code = String(e && (e.responseCode || e.code) || '');
    return { sent: false, reason: /535|EAUTH/.test(code) ? 'authentication_failed' : /ECONN|ETIMEDOUT|ENOTFOUND|ESOCKET/.test(code) ? 'unreachable' : 'send_failed' };
  }
}

// ---------------------------------------------------------------------------------------------------- templates
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function shell(title, bodyHtml, note) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;border:1px solid #dfe4fb;overflow:hidden">
<tr><td style="padding:22px 28px;background:linear-gradient(135deg,#4f6bff,#7c3aed);color:#fff;font-size:20px;font-weight:800;letter-spacing:.02em">RRE Entries</td></tr>
<tr><td style="padding:28px"><div style="font-size:20px;font-weight:800;margin:0 0 12px">${esc(title)}</div>${bodyHtml}
<div style="margin-top:22px;font-size:12px;color:#64748b;line-height:1.5">${note || ''}</div></td></tr></table>
<div style="font-size:11px;color:#94a3b8;margin-top:14px">This message was sent by RRE Entries. Please do not forward it.</div></td></tr></table></body></html>`;
}
const button = (url, label) => `<p style="margin:22px 0"><a href="${esc(url)}" style="display:inline-block;background:linear-gradient(135deg,#4f6bff,#7c3aed);color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:12px">${esc(label)}</a></p><p style="font-size:12px;color:#64748b;word-break:break-all">If the button does not work, copy this address into your browser:<br>${esc(url)}</p>`;

function resetEmail({ name, url, minutes }) {
  const hello = name ? `Hello ${name},` : 'Hello,';
  return {
    subject: 'Reset your RRE Entries password',
    text: `${hello}\n\nWe received a request to reset your RRE Entries password. Open this link to choose a new one (it works once and expires in ${minutes} minutes):\n\n${url}\n\nIf you did not ask for this, you can ignore this message: your password has not changed and nobody can reset it without this link.\n`,
    html: shell('Reset your password', `<p style="line-height:1.6">${esc(hello)}</p><p style="line-height:1.6">We received a request to reset your RRE Entries password. The link below works <b>once</b> and expires in <b>${minutes} minutes</b>.</p>${button(url, 'Choose a new password')}`,
      'If you did not ask for this, you can ignore this message: your password has not changed and nobody can reset it without this link.')
  };
}
function inviteEmail({ name, url, hours, role }) {
  const hello = name ? `Hello ${name},` : 'Hello,';
  return {
    subject: 'Your RRE Entries account is ready',
    text: `${hello}\n\nAn administrator created a ${role} account for you in RRE Entries. Open this link to choose your password (it works once and expires in ${hours} hours):\n\n${url}\n`,
    html: shell('Your account is ready', `<p style="line-height:1.6">${esc(hello)}</p><p style="line-height:1.6">An administrator created a <b>${esc(role)}</b> account for you in RRE Entries. Choose your password with the link below. It works <b>once</b> and expires in <b>${hours} hours</b>.</p>${button(url, 'Set my password')}`,
      'Nobody, including your administrator, can see the password you choose.')
  };
}
function verifyEmail({ name, url, hours }) {
  const hello = name ? `Hello ${name},` : 'Hello,';
  return {
    subject: 'Confirm your e-mail address for RRE Entries',
    text: `${hello}\n\nThank you for creating an RRE Entries customer account. Open this link to confirm your e-mail address and activate the account (it works once and expires in ${hours} hours):\n\n${url}\n\nIf you did not create this account, ignore this message: nothing is activated without the link.\n`,
    html: shell('Confirm your e-mail address', `<p style="line-height:1.6">${esc(hello)}</p><p style="line-height:1.6">Thank you for creating an RRE Entries customer account. Confirm your e-mail address to activate it. The link works <b>once</b> and expires in <b>${hours} hours</b>.</p>${button(url, 'Confirm my e-mail')}`,
      'If you did not create this account, ignore this message: nothing is activated without the link.')
  };
}
function existsEmail({ name }) {
  const hello = name ? `Hello ${name},` : 'Hello,';
  return {
    subject: 'You already have an RRE Entries account',
    text: `${hello}\n\nSomeone (hopefully you) tried to create an RRE Entries account with this e-mail address, but it already has one. Sign in, or use "Forgot password" on the sign-in page if you do not remember the password. No new account was created.\n`,
    html: shell('You already have an account', `<p style="line-height:1.6">${esc(hello)}</p><p style="line-height:1.6">Someone (hopefully you) tried to create an RRE Entries account with this e-mail address, but it already has one. Sign in, or use <b>Forgot password</b> on the sign-in page. No new account was created.</p>`, 'If this was not you, you can ignore this message.')
  };
}
function changedEmail({ name }) {
  const hello = name ? `Hello ${name},` : 'Hello,';
  return {
    subject: 'Your RRE Entries password was changed',
    text: `${hello}\n\nYour RRE Entries password was just changed. If this was you, no action is needed. If it was not you, contact your administrator immediately.\n`,
    html: shell('Password changed', `<p style="line-height:1.6">${esc(hello)}</p><p style="line-height:1.6">Your RRE Entries password was just changed and all your other sessions were signed out.</p>`,
      'If this was not you, contact your administrator immediately.')
  };
}

module.exports = { send, isConfigured, publicUrl, resetEmail, inviteEmail, verifyEmail, existsEmail, changedEmail, setTransport: (t) => { transport = t; cached = null; }, _cfg: () => { const c = cfg(); return { host: c.host, port: c.port, user: c.user ? c.user.replace(/^(.).*(@.*)$/, '$1***$2') : '' }; } };
