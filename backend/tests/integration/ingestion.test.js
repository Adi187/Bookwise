import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnvironment, readDatabaseUrl } from '../../src/config/env.js';
import { migrateUp } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/connection.js';
import { ingestEdition } from '../../src/ingestion/ingest.js';
import { BookError } from '../../src/books/archive.js';

const schema = `ingestion_test_${randomUUID().replaceAll('-', '')}`;
let admin;
let pool;
let databaseUrl;
const text = 'Chapter One\n\n' + 'Mira opened a book in the quiet library. The blue lantern marked the way home. '.repeat(200);
const archive = { downloadText: async identifier => ({ archiveIdentifier: identifier, title: 'Original test story', author: 'Noteway fixture', filename: 'fixture.txt', sourceUrl: `https://archive.org/details/${identifier}`, text, sizeBytes: Buffer.byteLength(text), sha1: 'a'.repeat(40) }) };
const embed = async batch => batch.map(() => Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0));

beforeAll(async () => {
  loadEnvironment();
  databaseUrl = readDatabaseUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  const testUrl = new URL(databaseUrl);
  const mainUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  if (!testUrl.pathname.includes('test') || (mainUrl && testUrl.hostname === mainUrl.hostname && testUrl.port === mainUrl.port && testUrl.pathname === mainUrl.pathname)) throw new Error('Use a dedicated TEST_DATABASE_URL.');
  admin = createPool(databaseUrl);
  await migrateUp(databaseUrl, { schema });
  testUrl.searchParams.set('options', `-c search_path=${schema},public`);
  pool = createPool(testUrl.href);
}, 30000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    // Generated name only: never drop public or a user-supplied schema.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

describe('real PostgreSQL ingestion publication (synthetic embeddings)', () => {
  it('applies migrations once and is a no-op when repeated', async () => {
    expect(await migrateUp(databaseUrl, { schema })).toHaveLength(0);
    const result = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='book_editions'", [schema]);
    expect(result.rows.map(row => row.column_name)).toContain('published_version');
  });
  it('publishes complete text/vector rows and reuses an already ready edition', async () => {
    const identifier = 'fixture-success';
    const spy = vi.fn(async batch => {
      const progress = await pool.query('SELECT status FROM book_editions WHERE archive_identifier=$1', [identifier]);
      expect(progress.rows[0].status).toBe('PROCESSING');
      expect((await pool.query('SELECT count(*)::integer AS n FROM book_chunks')).rows[0].n).toBe(0);
      return embed(batch);
    });
    const result = await ingestEdition({ pool, archive, embed: spy, identifier });
    const stored = await pool.query(`SELECT e.status,e.chunk_count,count(c.id)::integer AS total,min(public.vector_dims(c.embedding)) AS dimensions
      FROM book_editions e JOIN book_chunks c ON c.edition_id=e.id AND c.processing_version=e.published_version
      WHERE e.id=$1 GROUP BY e.id`, [result.editionId]);
    expect(stored.rows[0]).toMatchObject({ status: 'READY', total: result.chunks, chunk_count: result.chunks, dimensions: 1536 });
    const noCalls = vi.fn();
    expect((await ingestEdition({ pool, archive: { downloadText: noCalls }, embed: noCalls, identifier })).reused).toBe(true);
    expect(noCalls).not.toHaveBeenCalled();
  });
  it('records FAILED without chunks after an embedding failure, then retries successfully', async () => {
    const identifier = 'fixture-failed';
    await expect(ingestEdition({ pool, archive, identifier, embed: async () => { throw new BookError(502, 'EMBEDDING_UNAVAILABLE', 'Temporary failure'); } })).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
    const failed = await pool.query('SELECT * FROM book_editions WHERE archive_identifier=$1', [identifier]);
    expect(failed.rows[0]).toMatchObject({ status: 'FAILED', published_version: null, error_message: 'EMBEDDING_UNAVAILABLE' });
    expect((await pool.query('SELECT count(*)::integer AS n FROM book_chunks WHERE edition_id=$1', [failed.rows[0].id])).rows[0].n).toBe(0);
    expect((await ingestEdition({ pool, archive, identifier, embed })).status).toBe('READY');
  });
  it('rolls back inserted chunks if final publication fails', async () => {
    await pool.query(`ALTER TABLE book_editions ADD CONSTRAINT reject_fixture_publish CHECK (archive_identifier <> 'fixture-publish-failure' OR status <> 'READY')`);
    try {
      await expect(ingestEdition({ pool, archive, identifier: 'fixture-publish-failure', embed })).rejects.toMatchObject({ code: 'INGESTION_FAILED' });
      const failed = await pool.query("SELECT id,status,published_version FROM book_editions WHERE archive_identifier='fixture-publish-failure'");
      expect(failed.rows[0].status).toBe('FAILED');
      expect(failed.rows[0].published_version).toBeNull();
      expect((await pool.query('SELECT count(*)::integer AS n FROM book_chunks WHERE edition_id=$1', [failed.rows[0].id])).rows[0].n).toBe(0);
    } finally { await pool.query('ALTER TABLE book_editions DROP CONSTRAINT reject_fixture_publish'); }
  });
  it('prevents a concurrent worker and lets a rerun recover after the lock session closes', async () => {
    const client = await pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtextextended('noteway-ingest:fixture-lock', 0))");
    try {
      await expect(ingestEdition({ pool, archive, identifier: 'fixture-lock', embed })).rejects.toMatchObject({ code: 'INGESTION_BUSY' });
    } finally { client.release(true); }
    expect((await ingestEdition({ pool, archive, identifier: 'fixture-lock', embed })).status).toBe('READY');
  });
  it('enforces token budget before calling the embedding provider', async () => {
    const spy = vi.fn();
    await expect(ingestEdition({ pool, archive, identifier: 'fixture-budget', embed: spy, maxTokens: 1 })).rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXCEEDED' });
    expect(spy).not.toHaveBeenCalled();
  });
});

// Retrieval uses the same isolated schema and synthetic vectors as ingestion.
describe('edition-scoped retrieval', () => {
  it('returns at most five ordered passages and excludes other editions and unpublished versions', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const result = await ingestEdition({ pool, archive, embed, identifier: 'retrieval-target' });
    await ingestEdition({ pool, archive, embed, identifier: 'retrieval-other' });
    await pool.query(`INSERT INTO book_chunks (edition_id,processing_version,chunk_index,start_offset,end_offset,content,embedding,token_count)
      VALUES ($1,$2,999,0,10,'unpublished', $3::public.vector,1)`, [result.editionId, randomUUID(), JSON.stringify((await embed(['x']))[0])]);
    const retrieved = await retrievePassages({ pool, embed, identifier: 'retrieval-target', question: 'Where is the lantern?' });
    expect(retrieved.passages).toHaveLength(5);
    expect(retrieved.passages.map(p => p.chunkIndex)).toEqual([0, 1, 2, 3, 4]);
    for (const passage of retrieved.passages) {
      const stored = await pool.query('SELECT edition_id,processing_version FROM book_chunks WHERE id=$1', [passage.chunkId]);
      expect(stored.rows[0]).toEqual({ edition_id: result.editionId, processing_version: retrieved.publishedVersion });
      expect(passage.similarity).toBeCloseTo(1);
    }
  });
  it('rejects missing, failed, incompatible and incomplete editions before embedding', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const spy = vi.fn();
    await expect(retrievePassages({ pool, embed: spy, identifier: 'missing', question: 'What?' })).rejects.toMatchObject({ code: 'BOOK_NOT_FOUND' });
    const result = await ingestEdition({ pool, archive, embed, identifier: 'retrieval-invalid' });
    await pool.query("UPDATE book_editions SET status='FAILED' WHERE id=$1", [result.editionId]);
    await expect(retrievePassages({ pool, embed: spy, identifier: 'retrieval-invalid', question: 'What?' })).rejects.toMatchObject({ code: 'SOURCE_NOT_READY' });
    await pool.query("UPDATE book_editions SET status='READY',embedding_model='other' WHERE id=$1", [result.editionId]);
    await expect(retrievePassages({ pool, embed: spy, identifier: 'retrieval-invalid', question: 'What?' })).rejects.toMatchObject({ code: 'REPROCESS_REQUIRED' });
    await pool.query("UPDATE book_editions SET embedding_model='text-embedding-3-small',chunk_count=chunk_count+1 WHERE id=$1", [result.editionId]);
    await expect(retrievePassages({ pool, embed: spy, identifier: 'retrieval-invalid', question: 'What?' })).rejects.toMatchObject({ code: 'INCOMPLETE_EDITION' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('ranks by cosine distance rather than passage order', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const result = await ingestEdition({ pool, archive, embed, identifier: 'retrieval-ranking' });
    const orthogonal = Array(1536).fill(0); orthogonal[1] = 1;
    await pool.query('UPDATE book_chunks SET embedding=$2::public.vector WHERE edition_id=$1 AND chunk_index<>3', [result.editionId, JSON.stringify(orthogonal)]);
    const retrieved = await retrievePassages({ pool, embed, identifier: 'retrieval-ranking', question: 'What?' });
    expect(retrieved.passages[0].chunkIndex).toBe(3);
    expect(retrieved.passages[0].distance).toBeCloseTo(0);
    expect(retrieved.passages[1].distance).toBeCloseTo(1);
  });
  it('rejects invalid vectors and editions changed during embedding', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    await ingestEdition({ pool, archive, embed, identifier: 'retrieval-change' });
    await expect(retrievePassages({ pool, embed: async () => [[1]], identifier: 'retrieval-change', question: 'What?' })).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
    const changed = async batch => {
      await pool.query("UPDATE book_editions SET status='PROCESSING' WHERE archive_identifier='retrieval-change'");
      return embed(batch);
    };
    await expect(retrievePassages({ pool, embed: changed, identifier: 'retrieval-change', question: 'What?' })).rejects.toMatchObject({ code: 'SOURCE_NOT_READY' });
  });
});

// Exercise the browser contract against real SQL, without Archive/model charges.
describe('authenticated library, durable jobs and HTTP questions', () => {
  let app, token, otherToken, userId;
  let request, createWorker;
  const validate = vi.fn(async identifier => ({ eligible: true, archiveIdentifier: identifier,
    title: 'The Lantern Library', author: 'Noteway fixture', year: '1901', text: { filename: 'fixture.txt' } }));
  const ask = vi.fn(async ({ identifier, question }) => {
    const { askBook } = await import('../../src/questions/ask.js');
    return askBook({ pool, embed, identifier, question,
      generate: async evidence => ({ answer: 'The lantern is blue.', chunkIds: [evidence.passages[0].chunkId], insufficientEvidence: false }) });
  });
  beforeAll(async () => {
    request = (await import('supertest')).default;
    createWorker = (await import('../../src/jobs/worker.js')).createIngestionWorker;
    const { createApp } = await import('../../src/app.js');
    app = createApp({ pool, jwtSecret: 'test-only-secret-'.repeat(4), archive: { ...archive, validate }, ask,
      frontendOrigin: 'http://localhost:5173', checkDatabase: async () => {} });
    const first = await request(app).post('/api/auth/register').send({ email: 'reader@example.test', password: 'a-long-test-password' });
    expect(first.status).toBe(201);
    token = first.body.token; userId = first.body.user.id;
    const second = await request(app).post('/api/auth/register').send({ email: 'other@example.test', password: 'another-long-password' });
    otherToken = second.body.token;
  });
  const add = identifier => request(app).post('/api/sources').auth(token, { type: 'bearer' }).send({ archiveIdentifier: identifier });
  it('rejects anonymous writes and invalid credentials', async () => {
    expect((await request(app).post('/api/sources').send({ archiveIdentifier: 'http-book' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'reader@example.test', password: 'wrong-long-password' })).status).toBe(401);
  });
  it('atomically saves and queues concurrent adds once, then runs an owned Q&A request', async () => {
    const added = await Promise.all([add('http-book'), add('http-book')]);
    expect(added.map(r => r.status).sort()).toEqual([200, 201]);
    const source = added[0].body.source;
    expect(source).toMatchObject({ status: 'PROCESSING', title: 'The Lantern Library', canRetry: false });
    expect((await pool.query('SELECT count(*)::integer AS n FROM ingestion_jobs')).rows[0].n).toBe(1);
    expect((await request(app).get(`/api/sources/${source.id}`).auth(otherToken, { type: 'bearer' })).status).toBe(404);
    expect((await request(app).post(`/api/sources/${source.id}/questions`).auth(otherToken, { type: 'bearer' }).send({ question: 'What?' })).status).toBe(404);
    expect((await request(app).post(`/api/sources/${source.id}/questions`).auth(token, { type: 'bearer' }).send({ question: 'What?' })).status).toBe(409);
    expect(ask).not.toHaveBeenCalled();
    await createWorker({ pool, archive, embed }).runOnce();
    const answer = await request(app).post(`/api/sources/${source.id}/questions`).auth(token, { type: 'bearer' }).send({ question: 'What color is the lantern?' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ answer: 'The lantern is blue.', insufficientEvidence: false, archiveIdentifier: 'http-book' });
    expect(answer.body.references[0].excerpt).toContain('blue lantern');
    expect((await request(app).post(`/api/sources/${source.id}/questions`).auth(token, { type: 'bearer' }).send({ question: ' ', identifier: 'other-book' })).status).toBe(400);
    const membership = await request(app).get('/api/sources?identifiers=http-book,missing').auth(token, { type: 'bearer' });
    expect(membership.body.items).toHaveLength(1);
    expect(membership.body.items[0].status).toBe('READY');
  });
  it('persists failures, checks retry ownership and retries transient failures only', async () => {
    const source = (await add('http-retry')).body.source;
    await createWorker({ pool, archive, embed: async () => { throw new BookError(502, 'EMBEDDING_UNAVAILABLE', 'fixture'); } }).runOnce();
    const failed = await request(app).get(`/api/sources/${source.id}`).auth(token, { type: 'bearer' });
    expect(failed.body.source).toMatchObject({ status: 'FAILED', canRetry: true });
    expect((await request(app).post(`/api/sources/${source.id}/retry`).auth(otherToken, { type: 'bearer' }).send({})).status).toBe(404);
    const retries = await Promise.all([1, 2].map(() => request(app).post(`/api/sources/${source.id}/retry`).auth(token, { type: 'bearer' }).send({})));
    expect(retries.every(r => r.status === 200 && r.body.source.status === 'PROCESSING')).toBe(true);
    await createWorker({ pool, archive, embed }).runOnce();
    expect((await request(app).get(`/api/sources/${source.id}`).auth(token, { type: 'bearer' })).body.source.status).toBe('READY');
  });
  it('a fresh worker recovers a queued edition left PROCESSING after a crash', async () => {
    const source = (await add('http-crash')).body.source;
    await pool.query("UPDATE book_editions SET status='PROCESSING',processing_version=$1 WHERE archive_identifier='http-crash'", [randomUUID()]);
    const calls = vi.fn(embed);
    const workers = [createWorker({ pool, archive, embed: calls }), createWorker({ pool, archive, embed: calls })];
    await Promise.all(workers.map(w => w.runOnce()));
    const ready = (await request(app).get(`/api/sources/${source.id}`).auth(token, { type: 'bearer' })).body.source;
    expect(ready.status).toBe('READY');
    expect(calls).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT count(*)::integer AS n FROM ingestion_jobs')).rows[0].n).toBe(0);
  });
  it('does not enqueue an ineligible edition or expose provider diagnostics', async () => {
    validate.mockResolvedValueOnce({ eligible: false });
    expect((await add('http-ineligible')).status).toBe(422);
    expect((await pool.query("SELECT id FROM book_editions WHERE archive_identifier='http-ineligible'")).rowCount).toBe(0);
    const source = (await pool.query('SELECT id FROM user_sources WHERE user_id=$1 LIMIT 1', [userId])).rows[0];
    ask.mockRejectedValueOnce(new BookError(502, 'MODEL_KEY_MISSING', 'secret diagnostic'));
    const response = await request(app).post(`/api/sources/${source.id}/questions`).auth(token, { type: 'bearer' }).send({ question: 'What?' });
    expect(response.status).toBe(502);
    expect(response.text).not.toContain('secret diagnostic');
  });
});

describe('chapter-specific publication and retrieval', () => {
  const story = 'Preface\n\n' + 'This is the preface. '.repeat(30) + '\n\nChapter I\n\n' +
    'Mira listened to the keeper describe the stars. '.repeat(160) + '\n\nAt the ending, a bell rang and everyone went home.\n\n' +
    'Chapter II\n\n' + 'Mira returned and found that the lantern had disappeared. '.repeat(160) + '\n\nThe second chapter ended with the missing lantern.\n';
  const chapterArchive = { downloadText: async identifier => ({ ...(await archive.downloadText(identifier)), text: story, sizeBytes: Buffer.byteLength(story) }) };
  let id;
  beforeAll(async () => {
    id = (await ingestEdition({ pool, archive: chapterArchive, embed, identifier: 'chapter-test' })).editionId;
  });
  it('publishes chapter metadata and prevents overlap across boundaries', async () => {
    const edition = (await pool.query('SELECT chapter_index FROM book_editions WHERE id=$1', [id])).rows[0];
    expect(edition.chapter_index.map(c => c.number)).toEqual([1, 2]);
    const chunks = (await pool.query('SELECT chapter,start_offset,end_offset FROM book_chunks WHERE edition_id=$1', [id])).rows;
    for (const c of chunks.filter(c => c.chapter)) {
      const range = edition.chapter_index.find(r => r.title === c.chapter);
      expect(c.start_offset).toBeGreaterThanOrEqual(range.startOffset);
      expect(c.end_offset).toBeLessThanOrEqual(range.endOffset);
    }
  });
  it('gets the actual final passages without a semantic embedding call', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const spy = vi.fn();
    const result = await retrievePassages({ pool, embed: spy, identifier: 'chapter-test', question: 'What happened at the end of chapter one?' });
    expect(result.scope).toMatchObject({ number: 1, mode: 'ending' });
    expect(result.passages.every(p => p.chapter === 'Chapter 1')).toBe(true);
    expect(result.passages.at(-1).content).toContain('a bell rang and everyone went home');
    expect(result.passages.some(p => p.content.includes('lantern had disappeared'))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
  it('retrieves opening passages, complete short chapters, and chapter-filtered semantic results', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const opening = await retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'How does chapter II begin?' });
    expect(opening.scope.mode).toBe('beginning');
    expect(opening.passages[0].content).toContain('Chapter II');
    const summary = await retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'Summarize chapter one.' });
    expect(summary.scope.coverage).toBe('complete-chapter');
    const count = (await pool.query("SELECT count(*)::integer AS n FROM book_chunks WHERE edition_id=$1 AND chapter='Chapter 1'", [id])).rows[0].n;
    expect(summary.passages).toHaveLength(count);
    const semantic = await retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'Why is the lantern missing in Chapter 2?' });
    expect(semantic.passages.every(p => p.chapter === 'Chapter 2')).toBe(true);
    expect(semantic.scope.coverage).toBe('complete-chapter');
    expect(semantic.passages.at(-1).content).toContain('second chapter ended');
  });
  it('rejects unavailable and ambiguous chapter requests before generation or embedding', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const spy = vi.fn();
    await expect(retrievePassages({ pool, embed: spy, identifier: 'chapter-test', question: 'What happened in chapter 99?' })).rejects.toMatchObject({ code: 'CHAPTER_NOT_FOUND' });
    await expect(retrievePassages({ pool, embed: spy, identifier: 'chapter-test', question: 'Compare chapters 1 and 2.' })).rejects.toMatchObject({ code: 'CHAPTER_SCOPE_UNSUPPORTED' });
    await expect(retrievePassages({ pool, embed: spy, identifier: 'fixture-success', question: 'Explain Chapter I.' })).rejects.toMatchObject({ code: 'CHAPTERS_UNAVAILABLE' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('uses a verified chapter index with legacy embeddings', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const { LEGACY_PIPELINE_VERSION, PIPELINE_VERSION } = await import('../../src/ingestion/chunks.js');
    await pool.query('UPDATE book_editions SET pipeline_version=$2 WHERE id=$1', [id, LEGACY_PIPELINE_VERSION]);
    try {
      expect((await retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'Where is Mira?' })).passages.length).toBe(5);
      expect((await retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'Explain chapter 1.' })).passages.every(p => p.chapter === 'Chapter 1')).toBe(true);
    } finally { await pool.query('UPDATE book_editions SET pipeline_version=$2 WHERE id=$1', [id, PIPELINE_VERSION]); }
  });
  it('clips legacy chunks that straddle a newly indexed chapter boundary', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    const original = (await pool.query("SELECT * FROM book_chunks WHERE edition_id=$1 AND chapter='Chapter 2' ORDER BY chunk_index LIMIT 1", [id])).rows[0];
    const start = original.start_offset - 80;
    await pool.query('UPDATE book_chunks SET chapter=NULL,start_offset=$2,content=$3 WHERE id=$1', [original.id,start,story.slice(start,original.end_offset)]);
    try {
      const first = await retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'How does chapter 2 begin?' });
      expect(first.passages[0].startOffset).toBe(original.start_offset);
      expect(first.passages[0].content).toBe(original.content);
      const ending = await retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'How does chapter 1 end?' });
      expect(ending.passages.every(p => p.endOffset <= original.start_offset)).toBe(true);
      expect(ending.passages.some(p => p.content.includes('Chapter II'))).toBe(false);
    } finally {
      await pool.query('UPDATE book_chunks SET chapter=$2,start_offset=$3,content=$4 WHERE id=$1', [original.id,original.chapter,original.start_offset,original.content]);
    }
  });
  it('rejects over-budget whole-chapter summaries instead of silently omitting most of the chapter', async () => {
    const { retrievePassages } = await import('../../src/retrieval/retrieve.js');
    await pool.query("UPDATE book_chunks SET token_count=13000 WHERE edition_id=$1 AND chapter='Chapter 1'", [id]);
    try {
      await expect(retrievePassages({ pool, embed, identifier: 'chapter-test', question: 'Summarize Chapter I.' })).rejects.toMatchObject({ code: 'CHAPTER_TOO_LONG' });
      const spy = vi.fn(embed);
      const selected = await retrievePassages({ pool, embed: spy, identifier: 'chapter-test', question: 'Why does Mira listen in Chapter I?' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(selected.scope.coverage).toBe('selected-passages');
      expect(selected.passages.length).toBeLessThanOrEqual(15);
      expect(selected.passages.every(p => p.chapter === 'Chapter 1')).toBe(true);
      expect(selected.passages.map(p => p.chunkIndex)).toEqual([...selected.passages.map(p => p.chunkIndex)].sort((a, b) => a - b));
    }
    finally { await pool.query('UPDATE book_chunks SET token_count=500 WHERE edition_id=$1', [id]); }
  });
  it('preserves the published version on a failed reprocess and atomically replaces it on success', async () => {
    const before = (await pool.query('SELECT published_version,pipeline_version,chapter_index,chunk_count FROM book_editions WHERE id=$1', [id])).rows[0];
    await expect(ingestEdition({ pool, archive: chapterArchive, embed: async () => { throw new BookError(502, 'EMBEDDING_UNAVAILABLE', 'test'); }, identifier: 'chapter-test', reprocess: true })).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
    const after = (await pool.query('SELECT status,published_version,pipeline_version,chapter_index,chunk_count FROM book_editions WHERE id=$1', [id])).rows[0];
    expect(after).toEqual({ ...before, status: 'READY' });
    await ingestEdition({ pool, archive: chapterArchive, embed, identifier: 'chapter-test', reprocess: true });
    const replaced = (await pool.query('SELECT published_version FROM book_editions WHERE id=$1', [id])).rows[0];
    expect(replaced.published_version).not.toBe(before.published_version);
    expect((await pool.query('SELECT id FROM book_chunks WHERE edition_id=$1 AND processing_version=$2', [id, before.published_version])).rowCount).toBe(0);
  });
});

describe('password recovery', () => {
  it('resets existing accounts once, expires links, and revokes old sessions', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../../src/app.js');
    const delivery = vi.fn(async () => {});
    const app = createApp({ pool, jwtSecret: 'reset-test-secret-'.repeat(4), frontendOrigin: 'http://localhost:5173',
      checkDatabase: async () => {}, sendPasswordReset: delivery });
    const email = 'recovery@example.test';
    const oldPassword = 'old-long-password';
    const newPassword = 'new-long-password';
    const registration = await request(app).post('/api/auth/register').send({ email, password: oldPassword });
    expect(registration.status).toBe(201);
    const forgot = () => request(app).post('/api/auth/forgot-password').send({ email: ' RECOVERY@example.test ' });
    const response = await forgot();
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'missing@example.test' });
    expect(unknown.body).toEqual(response.body);
    expect(delivery).toHaveBeenCalledTimes(1);
    const getToken = () => new URLSearchParams(new URL(delivery.mock.calls.at(-1)[0].url).hash.slice(1)).get('token');
    const stale = getToken();
    await forgot();
    expect((await request(app).post('/api/auth/reset-password').send({ token: stale, password: newPassword })).status).toBe(400);
    const token = getToken();
    const stored = await pool.query('SELECT reset_token_hash FROM users WHERE email=$1', [email]);
    expect(stored.rows[0].reset_token_hash).not.toBe(token);
    const attempts = await Promise.all([1, 2].map(() => request(app).post('/api/auth/reset-password').send({ token, password: newPassword })));
    expect(attempts.map(r => r.status).sort()).toEqual([200, 400]);
    expect((await request(app).post('/api/auth/login').send({ email, password: oldPassword })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: newPassword })).status).toBe(200);
    expect((await request(app).get('/api/sources').auth(registration.body.token, { type: 'bearer' })).status).toBe(401);
    await forgot();
    await pool.query("UPDATE users SET reset_expires_at=now()-interval '1 second' WHERE email=$1", [email]);
    expect((await request(app).post('/api/auth/reset-password').send({ token: getToken(), password: newPassword })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset-password').send({ token: getToken(), password: 'short' })).status).toBe(400);
  });
});

describe('persistent browser sessions', () => {
  it('restores sessions, renews expiry, revokes logout, and rejects CSRF', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../../src/app.js');
    const app = createApp({ pool, jwtSecret: 'cookie-test-secret-'.repeat(4), frontendOrigin: 'http://localhost:5173', checkDatabase: async () => {} });
    const credentials = { email: 'persistent@example.test', password: 'a-persistent-password' };
    const registered = await request(app).post('/api/auth/register').send(credentials);
    expect(registered.status).toBe(201);
    const header = registered.headers['set-cookie'][0];
    expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Strict'); expect(header).toContain('Path=/api');
    const cookie = header.split(';')[0];
    expect((await request(app).get('/api/auth/session').set('Cookie', cookie)).body.user.email).toBe(credentials.email);
    expect((await request(app).get('/api/sources').set('Cookie', cookie)).status).toBe(200);
    const stored = await pool.query('SELECT token_hash,expires_at FROM auth_sessions WHERE user_id=$1', [registered.body.user.id]);
    expect(stored.rows[0].token_hash).not.toBe(cookie.split('=')[1]);
    expect(stored.rows[0].expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    expect((await request(app).post('/api/auth/logout').set('Origin', 'https://attacker.example').set('Cookie', cookie).send({})).status).toBe(403);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie).send({})).status).toBe(200);
    expect((await request(app).get('/api/auth/session').set('Cookie', cookie)).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send(credentials);
    const nextCookie = login.headers['set-cookie'][0].split(';')[0];
    await pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [registered.body.user.id]);
    expect((await request(app).get('/api/auth/session').set('Cookie', nextCookie)).status).toBe(401);
    const again = await request(app).post('/api/auth/login').send(credentials);
    await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [registered.body.user.id]);
    expect((await request(app).get('/api/auth/session').set('Cookie', again.headers['set-cookie'][0].split(';')[0])).status).toBe(401);
  });
});
