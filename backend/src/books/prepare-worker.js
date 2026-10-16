import { parentPort, workerData } from 'node:worker_threads';
import { prepareText } from '../ingestion/prepare.js';
try {
  const { chunks, tokens } = prepareText(workerData.text, workerData.maxTokens);
  parentPort.postMessage({ chunks: chunks.length, tokens });
} catch (error) {
  parentPort.postMessage({ error: { status: error.status, code: error.code, message: error.message } });
}
