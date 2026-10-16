import { ingestEdition } from '../ingestion/ingest.js';

// The queue is durable; the timer only wakes a worker. No job belongs to an HTTP request.
export function createIngestionWorker({ pool, archive, embed, maxTokens, ingest = ingestEdition, intervalMs = 2000,
  onError = () => console.error('The ingestion worker could not complete a database operation.') }) {
  let stopping = false;
  let timer;
  let running;
  async function runOnce() {
    const jobs = await pool.query(`SELECT j.id,j.edition_id,e.archive_identifier FROM ingestion_jobs j
      JOIN book_editions e ON e.id=j.edition_id ORDER BY j.created_at LIMIT 20`);
    for (const job of jobs.rows) {
      const client = await pool.connect();
      try {
        const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`noteway-job:${job.edition_id}`]);
        if (!lock.rows[0].acquired) continue;
        // A competing worker may have finished between the candidate query and lock acquisition.
        if (!(await client.query('SELECT id FROM ingestion_jobs WHERE edition_id=$1 AND id=$2', [job.edition_id, job.id])).rowCount) continue;
        let failure;
        try { await ingest({ pool, archive, embed, maxTokens, identifier: job.archive_identifier }); }
        catch (error) { if (error.code === 'INGESTION_BUSY') continue; failure = error; }
        // Finalize atomically against retry requests, which lock the same edition row.
        await client.query('BEGIN');
        await client.query('SELECT id FROM book_editions WHERE id=$1 FOR UPDATE', [job.edition_id]);
        if (failure) await client.query(`UPDATE book_editions SET status='FAILED',error_message=$2,updated_at=now()
          WHERE id=$1 AND status<>'READY'`, [job.edition_id, failure.code || 'INGESTION_FAILED']);
        await client.query('DELETE FROM ingestion_jobs WHERE edition_id=$1 AND id=$2', [job.edition_id, job.id]);
        await client.query('COMMIT');
        return true;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(true); }
    }
    return false;
  }
  function tick() {
    if (stopping) return;
    running = runOnce().catch(onError).finally(() => { if (!stopping) timer = setTimeout(tick, intervalMs); });
  }
  return { runOnce, start: tick, async stop() { stopping = true; clearTimeout(timer); await running; } };
}
