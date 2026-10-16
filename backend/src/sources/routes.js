import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { BookError } from '../books/errors.js';
import { validIdentifier } from '../books/archive.js';
import { createSources } from './service.js';

export function sourceRoutes({ pool, auth, archive, ask, requireModels }) {
  const router = Router();
  const sources = createSources({ pool, archive, requireModels });
  router.use(auth.requireUser);
  const mutations = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, keyGenerator: req => req.user.id,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } } });
  const questions = rateLimit({ windowMs: 60 * 1000, limit: 10, keyGenerator: req => req.user.id,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many questions. Please try again shortly.' } } });
  const activeQuestions = new Set();
  router.get('/', async (req, res) => {
    const page = req.query.page ?? '1';
    if (typeof page !== 'string' || !/^[1-9]\d{0,3}$/.test(page)) throw new BookError(400, 'VALIDATION_ERROR', 'Invalid page.');
    let identifiers;
    if (req.query.identifiers !== undefined) {
      if (typeof req.query.identifiers !== 'string') throw new BookError(400, 'VALIDATION_ERROR', 'Invalid editions.');
      identifiers = req.query.identifiers.split(',');
      if (identifiers.length > 20 || !identifiers.every(validIdentifier)) throw new BookError(400, 'VALIDATION_ERROR', 'Invalid editions.');
    }
    res.json(await sources.list(req.user.id, { page: Number(page), identifiers }));
  });
  router.post('/', mutations, async (req, res) => {
    if (!req.body || Object.keys(req.body).some(k => k !== 'archiveIdentifier') || !validIdentifier(req.body.archiveIdentifier)) throw new BookError(400, 'VALIDATION_ERROR', 'Provide a valid Archive identifier.');
    const { source, created } = await sources.add(req.user.id, req.body.archiveIdentifier);
    res.status(created ? 201 : 200).json({ source });
  });
  router.get('/:sourceId', async (req, res) => res.json({ source: await sources.owned(req.user.id, req.params.sourceId) }));
  router.post('/:sourceId/retry', mutations, async (req, res) => res.json({ source: await sources.retry(req.user.id, req.params.sourceId) }));
  router.post('/:sourceId/questions', questions, async (req, res) => {
    const source = await sources.owned(req.user.id, req.params.sourceId);
    if (source.status !== 'READY') throw new BookError(409, 'SOURCE_NOT_READY', 'This book is not ready for questions yet.');
    if (!req.body || Object.keys(req.body).some(k => k !== 'question') || typeof req.body.question !== 'string' ||
        !req.body.question.trim() || req.body.question.trim().length > 2000) throw new BookError(400, 'VALIDATION_ERROR', 'Enter a question of 1–2000 characters.');
    if (!ask) throw new BookError(503, 'MODEL_UNAVAILABLE', 'Answering questions is temporarily unavailable.');
    if (activeQuestions.has(req.user.id) || activeQuestions.size >= 5) throw new BookError(429, 'RATE_LIMITED', 'Please wait for the current questions to finish.');
    activeQuestions.add(req.user.id);
    try { res.json(await ask({ identifier: source.archiveIdentifier, question: req.body.question.trim() })); }
    finally { activeQuestions.delete(req.user.id); }
  });
  return router;
}
