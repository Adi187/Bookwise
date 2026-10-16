import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export class ConfigurationError extends Error {}

export function loadEnvironment() {
  if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
  }
}

export function readDatabaseUrl(value, name = 'DATABASE_URL') {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error();
    }
    if (!url.username || !url.password || decodeURIComponent(url.password) === 'replace_me') throw new Error();
    return value;
  } catch {
    throw new ConfigurationError(`${name} must be a PostgreSQL connection URL with a database name, username, and non-placeholder password.`);
  }
}

export function readConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ConfigurationError('NODE_ENV must be development, test, or production.');
  }
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer from 1 to 65535.');
  }
  const databaseUrl = readDatabaseUrl(env.DATABASE_URL);
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim().length < 32 || jwtSecret.startsWith('replace_')) {
    throw new ConfigurationError('JWT_SECRET must contain at least 32 random characters, not a placeholder.');
  }
  let frontendOrigin;
  try {
    const url = new URL(env.FRONTEND_ORIGIN || 'http://localhost:5173');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error();
    if (nodeEnv === 'production' && url.protocol !== 'https:') throw new Error();
    frontendOrigin = url.origin;
  } catch {
    throw new ConfigurationError('FRONTEND_ORIGIN must be an HTTP origin (HTTPS in production), without a path or credentials.');
  }
  const maxEmbeddingTokens = Number(env.MAX_EMBEDDING_TOKENS || 1000000);
  if (!Number.isSafeInteger(maxEmbeddingTokens) || maxEmbeddingTokens < 1) throw new ConfigurationError('MAX_EMBEDDING_TOKENS must be a positive safe integer.');
  return Object.freeze({
    nodeEnv,
    resendApiKey: env.RESEND_API_KEY,
    passwordResetFrom: env.PASSWORD_RESET_FROM,
    host: env.HOST || '127.0.0.1',
    port,
    databaseUrl,
    jwtSecret,
    maxEmbeddingTokens,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    frontendOrigin,
  });
}
