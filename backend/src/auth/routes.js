import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
export function authRoutes(auth) {
  const router = Router();
  router.get('/session', auth.requireUser, (req, res) => res.json({ user: req.user }));
  router.post('/logout', async (req, res) => { await auth.sessions.logout(req, res); res.json({ message: 'Signed out.' }); });
  router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'AUTH_RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } } }));
  for (const mode of ['register', 'login']) router.post(`/${mode}`, async (req, res) => {
    const result = await auth[mode](req.body);
    await auth.sessions.issue(req, res, result.user);
    res.status(mode === 'register' ? 201 : 200).json(result);
  });
  router.post('/forgot-password', async (req, res) => res.json(await auth.forgotPassword(req.body)));
  router.post('/reset-password', async (req, res) => res.json(await auth.resetPassword(req.body)));
  return router;
}
