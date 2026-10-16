import { createHash, randomBytes } from 'node:crypto';
const cookieName = 'noteway_session';
const lifetime = 30 * 24 * 60 * 60 * 1000;
const digest = token => createHash('sha256').update(token).digest('hex');
export function createSessions({ pool, frontendOrigin }) {
  const options = { httpOnly: true, secure: frontendOrigin?.startsWith('https:') || process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api', maxAge: lifetime };
  const read = req => {
    const value = (req.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
  };
  return {
    async issue(req, res, user) {
      const token = randomBytes(32).toString('hex');
      await pool.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
      await pool.query(`INSERT INTO auth_sessions(token_hash,user_id,auth_version,expires_at)
        SELECT $1,id,auth_version,now()+interval '30 days' FROM users WHERE id=$2`, [digest(token), user.id]);
      const previous = read(req);
      if (previous) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [digest(previous)]);
      res.cookie(cookieName, token, options);
    },
    async restore(req, res) {
      const token = read(req);
      if (!token) return null;
      const { rows } = await pool.query(`UPDATE auth_sessions s SET expires_at=now()+interval '30 days'
        FROM users u WHERE s.token_hash=$1 AND s.user_id=u.id AND s.auth_version=u.auth_version AND s.expires_at>now()
        RETURNING u.id,u.email`, [digest(token)]);
      if (!rows.length) { res.clearCookie(cookieName, options); return null; }
      res.cookie(cookieName, token, options);
      return rows[0];
    },
    async logout(req, res) {
      const token = read(req);
      if (token) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [digest(token)]);
      res.clearCookie(cookieName, options);
    },
  };
}
