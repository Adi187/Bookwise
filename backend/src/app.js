import express from 'express';
import cors from 'cors';
import { BookError, createArchiveService } from './books/archive.js';
import { bookRoutes } from './books/routes.js';
import { createAuth } from './auth/service.js';
import { authRoutes } from './auth/routes.js';
import { sourceRoutes } from './sources/routes.js';

export function createApp({ frontendOrigin, checkDatabase, archive = createArchiveService(), pool, jwtSecret, sendPasswordReset, ask, requireModels }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: frontendOrigin, methods: ['GET', 'POST', 'OPTIONS'], credentials: true }));
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.get('Origin') && req.get('X-Noteway-Request') !== '1') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This request is not allowed.' } });
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await checkDatabase();
      res.set('Cache-Control', 'no-store').json({ status: 'ok', database: 'connected' });
    } catch {
      res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The service is temporarily unavailable.' } });
    }
  });

  app.use('/api/books', bookRoutes(archive));
  if (pool) {
    const auth = createAuth({ pool, jwtSecret, frontendOrigin, sendPasswordReset });
    app.use(['/api/auth', '/api/sources'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.use('/api/auth', authRoutes(auth));
    app.use('/api/sources', sourceRoutes({ pool, auth, archive, ask, requireModels }));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.' } });
  });

  // Express recognizes error middleware by its four-argument signature.
  app.use((error, _req, res, _next) => {
    if (error instanceof BookError) {
      const internal = /^(MODEL_|EMBEDDING_|RETRIEVAL_|INGESTION_FAILED|REPROCESS_|INCOMPLETE_|ANSWER_|CITATION_)/.test(error.code);
      return res.status(error.status).json({ error: { code: error.code,
        message: internal ? 'We could not complete this request. Please try again later.' : error.message } });
    }
    const malformed = error.type === 'entity.parse.failed';
    const oversized = error.type === 'entity.too.large';
    res.status(oversized ? 413 : malformed ? 400 : 500).json({
      error: {
        code: oversized ? 'PAYLOAD_TOO_LARGE' : malformed ? 'INVALID_JSON' : 'INTERNAL_ERROR',
        message: oversized ? 'The request is too large.' : malformed ? 'The request must contain valid JSON.' : 'An unexpected error occurred.',
      },
    });
  });
  return app;
}
