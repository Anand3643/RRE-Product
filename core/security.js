/**
 * RRE Tally — Enterprise Security, Cryptography & Access Control Subsystem
 * Implements:
 * 1. Cryptographic Password Hashing (Salted PBKDF2 with SHA-512)
 * 2. Transparent Password Migration from Plaintext/Legacy
 * 3. Secure HMAC-SHA256 Session Tokens
 * 4. Brute-Force Rate Limiter for Login Protection
 * 5. HTTP Security Headers & Origin Lockdown
 * 6. Input Sanitization Helpers
 */

const crypto = require('crypto');

// Environment or runtime secret for session signatures
// Persisted next to the company data so sessions survive an app restart (still never leaves the PC).
function loadOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const fs = require('fs');
    const path = require('path');
    const paths = require('./paths');
    // Test override first; otherwise the data ROOT (shared by all companies on this PC). An existing secret in the
    // original company folder (created by earlier versions) is reused so current sessions' signing key does not change.
    const dirs = process.env.RRE_DATA_DIR ? [path.resolve(process.env.RRE_DATA_DIR)] : [paths.companyDir(paths.DEFAULT_COMPANY), paths.ROOT];
    for (const d of dirs) {
      const f = path.join(d, '.session_secret');
      if (fs.existsSync(f)) { const existing = fs.readFileSync(f, 'utf8').trim(); if (existing.length >= 32) return existing; }
    }
    const dir = dirs[0];
    fs.mkdirSync(dir, { recursive: true });
    const fresh = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, '.session_secret'), fresh, { encoding: 'utf8', mode: 0o600 });
    return fresh;
  } catch (e) {
    return crypto.randomBytes(32).toString('hex'); // fall back to per-process secret
  }
}
const SESSION_SECRET = loadOrCreateSessionSecret();

// db.js registers a function returning the active company number, so tokens can be bound to a company
let companyProvider = null;
function setCompanyProvider(fn) { companyProvider = fn; }
const PBKDF2_ITERATIONS = 10000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

/**
 * Cryptographically hashes a password using PBKDF2 with a random 16-byte salt
 * @param {string} password 
 * @returns {string} Format: pbkdf2$iterations$salt$hash
 */
function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST
  ).toString('hex');

  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${derivedKey}`;
}

/**
 * Verifies an incoming password against stored value.
 * Supports both modern salted PBKDF2 hashes and legacy plaintext for seamless migration.
 * @param {string} inputPassword 
 * @param {string} storedHash 
 * @returns {{ valid: boolean, needsMigration: boolean }}
 */
function verifyPassword(inputPassword, storedHash) {
  const p = (inputPassword || '').trim();
  const stored = (storedHash || '').trim();

  // Modern PBKDF2 Hash
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length === 4) {
      const iterations = parseInt(parts[1], 10);
      const salt = parts[2];
      const originalHash = parts[3];

      const checkHash = crypto.pbkdf2Sync(
        p,
        salt,
        iterations,
        originalHash.length / 2,
        PBKDF2_DIGEST
      ).toString('hex');

      try {
        const isMatch = crypto.timingSafeEqual(
          Buffer.from(checkHash, 'hex'),
          Buffer.from(originalHash, 'hex')
        );
        return { valid: isMatch, needsMigration: false };
      } catch (e) {
        return { valid: false, needsMigration: false };
      }
    }
  }

  // Legacy Plaintext Match (transparent backward compatibility)
  const isPlainMatch = (stored === p);
  return {
    valid: isPlainMatch,
    needsMigration: isPlainMatch // flag to immediately re-hash in database
  };
}

/**
 * Creates a cryptographically signed session token with expiry
 * @param {object} user 
 * @param {number} expiresInHours 
 * @returns {string} Signed token
 */
function createSessionToken(user, expiresInHours = 24) {
  const expiresAt = Date.now() + (expiresInHours * 60 * 60 * 1000);
  const payload = JSON.stringify({
    userId: user.id,
    username: user.username,
    role: user.role,
    ...(user.must_change_password ? { pwc: 1 } : {}),
    ...(companyProvider ? { company: companyProvider() } : {}),
    expiresAt
  });

  const encodedPayload = Buffer.from(payload).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encodedPayload)
    .digest('base64url');

  return `rre_${encodedPayload}.${signature}`;
}

/**
 * Verifies and decodes a signed session token
 * @param {string} token 
 * @returns {{ valid: boolean, user?: object, error?: string }}
 */
function verifySessionToken(token) {
  if (!token || !token.startsWith('rre_')) {
    return { valid: false, error: 'Malformed token structure' };
  }

  try {
    const raw = token.slice(4);
    const [encodedPayload, signature] = raw.split('.');
    if (!encodedPayload || !signature) {
      return { valid: false, error: 'Invalid token parts' };
    }

    const expectedSignature = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(encodedPayload)
      .digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return { valid: false, error: 'Invalid token signature' };
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (Date.now() > payload.expiresAt) {
      return { valid: false, error: 'Session token expired' };
    }

    return { valid: true, user: payload };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * In-Memory Sliding-Window Rate Limiter for Login Protection
 * Protects against brute-force password cracking attacks.
 */
class LoginRateLimiter {
  constructor(maxAttempts = 10, windowMs = 5 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map(); // ip -> { count, firstAttemptTime, blockedUntil }

    // Periodic cleanup of stale records every 10 minutes
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.attempts.entries()) {
      if (now > record.firstAttemptTime + this.windowMs && (!record.blockedUntil || now > record.blockedUntil)) {
        this.attempts.delete(key);
      }
    }
  }

  check(key) {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record) {
      return { allowed: true, remaining: this.maxAttempts, retryAfterSeconds: 0 };
    }

    if (record.blockedUntil && now < record.blockedUntil) {
      const retryAfterSeconds = Math.ceil((record.blockedUntil - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    if (now > record.firstAttemptTime + this.windowMs) {
      this.attempts.delete(key);
      return { allowed: true, remaining: this.maxAttempts, retryAfterSeconds: 0 };
    }

    const remaining = Math.max(0, this.maxAttempts - record.count);
    return { allowed: record.count < this.maxAttempts, remaining, retryAfterSeconds: 0 };
  }

  recordFailure(key) {
    const now = Date.now();
    const record = this.attempts.get(key) || { count: 0, firstAttemptTime: now, blockedUntil: 0 };

    if (now > record.firstAttemptTime + this.windowMs) {
      record.count = 1;
      record.firstAttemptTime = now;
      record.blockedUntil = 0;
    } else {
      record.count += 1;
    }

    if (record.count >= this.maxAttempts) {
      record.blockedUntil = now + this.windowMs; // Lock out for window period
    }

    this.attempts.set(key, record);
    return record;
  }

  recordSuccess(key) {
    this.attempts.delete(key);
  }
}

const loginRateLimiter = new LoginRateLimiter(10, 5 * 60 * 1000); // 10 attempts per 5 mins

/**
 * Express Middleware for Security Headers
 */
function securityHeadersMiddleware(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Clickjacking protection (sameorigin allows embedding in electron webviews if needed)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Legacy XSS filter
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Privacy referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict sensitive browser APIs
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self)');
  // Content Security Policy adapted for offline Tally desktop application
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:* https://api.github.com; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;"
  );

  next();
}

/**
 * Express Middleware for Rate Limiting Login Attempts
 */
function rateLimitLoginMiddleware(req, res, next) {
  const clientIp = req.ip || req.connection?.remoteAddress || '127.0.0.1';
  const status = loginRateLimiter.check(clientIp);

  if (!status.allowed) {
    return res.status(429).json({
      success: false,
      error: `Too many failed login attempts. Account temporarily locked for security. Try again in ${status.retryAfterSeconds} seconds.`,
      retry_after: status.retryAfterSeconds
    });
  }

  next();
}

/**
 * Simple text sanitizer for database fields
 */
function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').trim();
}

/** Pass proving a voucher replay was authorised by the approval workflow (valid only together with the stored request). */
function signApprovalPass(id) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(`approval:${id}`).digest('hex');
}
function verifyApprovalPass(id, sig) {
  const expected = signApprovalPass(id);
  const a = Buffer.from(String(sig)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  signApprovalPass,
  verifyApprovalPass,
  setCompanyProvider,
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  loginRateLimiter,
  securityHeadersMiddleware,
  rateLimitLoginMiddleware,
  sanitizeInput
};
