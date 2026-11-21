/**
 * RRE Tally — password rules shared by first-time setup, password change, administrator-created accounts and resets.
 * Returns a plain-language reason when a password is not acceptable, or null when it is.
 */
const MIN = 10, MAX = 100;

// Passwords that are never acceptable (shipped defaults, keyboard walks and the most common choices)
const BLOCKED = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty123', 'qwertyuiop', 'letmein123', 'welcome123', 'welcome1234',
  'admin123', 'administrator', 'admin12345', 'accountant', 'acc123', 'data123', 'audit123', 'view123', 'guest123',
  'rretally123', 'tally1234', 'tallyprime', 'changeme123', '1234567890', '0123456789', 'abcdefghij', 'iloveyou123'
]);

function checkPassword(pw, { username = '' } = {}) {
  if (typeof pw !== 'string') return 'A password is required.';
  const p = pw.trim();
  if (p.length < MIN) return `The password must be at least ${MIN} characters long.`;
  if (p.length > MAX) return `The password must be at most ${MAX} characters long.`;
  if (!/\p{L}/u.test(p) || !/\p{N}/u.test(p)) return 'The password must contain at least one letter and one number.';
  const lower = p.toLowerCase();
  if (BLOCKED.has(lower)) return 'That password is too common or is a known default. Please choose another.';
  if (/^(.)\1+$/u.test(p)) return 'The password cannot be one repeated character.';
  const u = String(username || '').trim().toLowerCase();
  if (u.length >= 3 && lower.includes(u)) return 'The password cannot contain your username.';
  return null;
}

module.exports = { checkPassword, MIN, MAX };
