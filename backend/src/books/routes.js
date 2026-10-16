import { Router } from 'express';
import { BookError, validIdentifier } from './archive.js';

export function bookRoutes(archive) {
  const router = Router();
  router.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g, ' ') : '';
    const pageText = req.query.page ?? '1';
    if (q.length < 2 || q.length > 120 || typeof pageText !== 'string' || !/^[1-9]\d{0,3}$/.test(pageText)) {
      throw new BookError(400, 'VALIDATION_ERROR', 'Enter a topic, genre, title or author between 2 and 120 characters and a page from 1 to 9999.');
    }
    res.set('Cache-Control', 'no-store');
    if (!req.get('Accept')?.includes('application/x-ndjson')) {
      return res.json(await archive.search(q, Number(pageText)));
    }
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.on('close', disconnect);
    res.set({ 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = data => { if (!controller.signal.aborted) res.write(`${JSON.stringify(data)}\n`); };
    try {
      const result = await archive.search(q, Number(pageText), { signal: controller.signal, onProgress: send });
      send({ ...result, complete: true });
    } catch (error) {
      send({ error: { code: error instanceof BookError ? error.code : 'INTERNAL_ERROR', message: 'Book checks could not be completed. Please try again.' } });
    } finally {
      res.off('close', disconnect);
      res.end();
    }
  });
  router.get('/:archiveIdentifier/eligibility', async (req, res) => {
    if (!validIdentifier(req.params.archiveIdentifier)) throw new BookError(400, 'VALIDATION_ERROR', 'Invalid Archive identifier.');
    res.set('Cache-Control', 'no-store').json(await archive.eligibility(req.params.archiveIdentifier));
  });
  router.get('/:archiveIdentifier', async (req, res) => {
    if (!validIdentifier(req.params.archiveIdentifier)) throw new BookError(400, 'VALIDATION_ERROR', 'Invalid Archive identifier.');
    const checked = await archive.validate(req.params.archiveIdentifier);
    if (!checked.eligible) throw new BookError(422, 'BOOK_UNAVAILABLE', 'This edition is no longer available for Noteway. Try another edition.');
    res.set('Cache-Control', 'no-store').json({ book: { archiveIdentifier: checked.archiveIdentifier,
      title: checked.title, author: checked.author, year: checked.year, eligible: true } });
  });
  return router;
}
