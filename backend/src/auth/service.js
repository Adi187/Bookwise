import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createSessions } from './sessions.js';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { BookError } from '../books/errors.js';
const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const isUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await scrypt(password, salt, 64, options)).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [version, salt, hash] = (stored || '').split('$');
  if (version !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(await scrypt(password, salt, 64, options), Buffer.from(hash, 'hex'));
}
export function createAuth({ pool, jwtSecret, sendPasswordReset, frontendOrigin }) {
  if (typeof jwtSecret !== 'string' || jwtSecret.trim().length < 32 || jwtSecret.startsWith('replace_')) throw new Error('A strong JWT_SECRET is required.');
  const sessions = createSessions({ pool, frontendOrigin });
  const key = new TextEncoder().encode(jwtSecret);
  const issuer = 'noteway'; const audience = 'noteway-web';
  const dummy = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  async function session(user) {
    const token = await new SignJWT({ version: user.auth_version || 0 }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id)
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(key);
    return { user: { id: user.id, email: user.email }, token };
  }
  function credentials(body) {
    if (!body || typeof body.email !== 'string' || typeof body.password !== 'string' || Object.keys(body).some(k => !['email', 'password'].includes(k))) throw new BookError(400, 'VALIDATION_ERROR', 'Provide an email and password.');
    const email = body.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || body.password.length < 12 || body.password.length > 128) throw new BookError(400, 'VALIDATION_ERROR', 'Use a valid email and a password of 12–128 characters.');
    return { email, password: body.password };
  }
  return {
    sessions,
    async register(body) {
      const { email, password } = credentials(body);
      const hash = await hashPassword(password);
      try {
        const { rows } = await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email,auth_version', [email, hash]);
        return session(rows[0]);
      } catch (error) {
        if (error.code === '23505') throw new BookError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
        throw error;
      }
    },
    async login(body) {
      const { email, password } = credentials(body);
      const { rows } = await pool.query('SELECT id,email,password_hash,auth_version FROM users WHERE lower(email)=$1', [email]);
      const valid = await verifyPassword(password, rows[0]?.password_hash || dummy);
      if (!rows[0] || !valid) throw new BookError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      return session(rows[0]);
    },
    async forgotPassword(body) {
      if (!body || typeof body.email !== 'string' || Object.keys(body).some(k => k !== 'email')) throw new BookError(400, 'VALIDATION_ERROR', 'Provide a valid email address.');
      const email = body.email.trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BookError(400, 'VALIDATION_ERROR', 'Provide a valid email address.');
      if (!sendPasswordReset) throw new BookError(503, 'RESET_UNAVAILABLE', 'Password reset is temporarily unavailable.');
      const token = randomBytes(32).toString('hex');
      const digest = createHash('sha256').update(token).digest('hex');
      const { rows } = await pool.query(`UPDATE users SET reset_token_hash=$2, reset_expires_at=now()+interval '30 minutes'
        WHERE lower(email)=$1 RETURNING id,email`, [email, digest]);
      if (rows.length) {
        const url = new URL('/reset-password', frontendOrigin);
        url.hash = new URLSearchParams({ token }).toString();
        try { await sendPasswordReset({ email: rows[0].email, url: url.href }); }
        catch {
          await pool.query('UPDATE users SET reset_token_hash=NULL,reset_expires_at=NULL WHERE id=$1 AND reset_token_hash=$2', [rows[0].id, digest]);
          // Keep the response identical for registered and unknown addresses.
          console.error('Password reset email delivery failed.');
        }
      }
      return { message: 'If an account exists for this email, you will receive a password reset link.' };
    },
    async resetPassword(body) {
      if (!body || typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token) ||
          typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128 ||
          Object.keys(body).some(k => !['token', 'password'].includes(k))) throw new BookError(400, 'VALIDATION_ERROR', 'Provide a reset token and a password of 12–128 characters.');
      const digest = createHash('sha256').update(body.token).digest('hex');
      const hash = await hashPassword(body.password);
      const { rows } = await pool.query(`UPDATE users SET password_hash=$2,reset_token_hash=NULL,reset_expires_at=NULL,auth_version=auth_version+1
        WHERE reset_token_hash=$1 AND reset_expires_at>now() RETURNING id`, [digest, hash]);
      if (!rows.length) throw new BookError(400, 'RESET_INVALID', 'This reset link has expired or already been used. Request a new link.');
      return { message: 'Your password has been updated. Sign in with your new password.' };
    },
    async requireUser(req, res, next) {
      if (!req.get('Authorization')) {
        const user = await sessions.restore(req, res);
        if (!user) throw new BookError(401, 'UNAUTHORIZED', 'Sign in to continue.');
        req.user = user;
        return next();
      }
      const match = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') || '');
      if (!match || match[1].length > 4096) throw new BookError(401, 'UNAUTHORIZED', 'Sign in to continue.');
      let payload;
      try {
        ({ payload } = await jwtVerify(match[1], key, { algorithms: ['HS256'], issuer, audience, typ: 'JWT', requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: '1h' }));
        if (!isUuid(payload.sub)) throw new Error();
      } catch { throw new BookError(401, 'UNAUTHORIZED', 'Your session has expired. Sign in again.'); }
      const { rows } = await pool.query('SELECT id,email,auth_version FROM users WHERE id=$1', [payload.sub]);
      if (!rows.length || (payload.version || 0) !== rows[0].auth_version) throw new BookError(401, 'UNAUTHORIZED', 'Sign in to continue.');
      req.user = rows[0];
      next();
    },
  };
}
