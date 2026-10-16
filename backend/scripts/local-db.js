// Local development only. Uses PostgreSQL executables and Node's standard library.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const local = join(root, '.local');
const data = join(local, 'postgres');
const socket = join(local, 'pg-socket');
const envPath = join(root, 'backend/.env');
const port = '5432';
const action = process.argv[2];
const pgBin = process.env.PG_BIN || ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin']
  .find((path) => existsSync(join(path, 'pg_ctl')));
const binary = (name) => pgBin ? join(pgBin, name) : name;

function run(name, args, input) {
  const result = spawnSync(binary(name), args, { encoding: 'utf8', input });
  if (result.error || result.status !== 0) {
    // SQL and subprocess output may contain credentials. Never echo them here.
    throw new Error(`${name} failed. Check PostgreSQL installation, local file permissions, and port ${port}. Server logs are in .local/postgres.log.`);
  }
  return result.stdout.trim();
}

function sql(database, statement) {
  return run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', socket, '-p', port, '-U', 'noteway_local_admin', '-d', database], statement);
}

function isRunning() {
  return spawnSync(binary('pg_ctl'), ['-D', data, 'status'], { stdio: 'ignore' }).status === 0;
}

function start() {
  if (!existsSync(join(data, 'PG_VERSION'))) throw new Error('Run npm run db:setup first.');
  if (!isRunning()) {
    run('pg_ctl', ['-D', data, '-l', join(local, 'postgres.log'), '-w', 'start']);
  }
}

try {
  if (!['setup', 'start', 'stop'].includes(action)) throw new Error('Usage: local-db.js setup|start|stop');
  if (action === 'stop') {
    if (isRunning()) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    console.info('Project PostgreSQL stopped.');
  } else if (action === 'start') {
    start();
    console.info(`Project PostgreSQL is running on 127.0.0.1:${port}.`);
  } else {
    mkdirSync(local, { recursive: true, mode: 0o700 });
    mkdirSync(socket, { recursive: true, mode: 0o700 });
    // Refuse existing user configuration unless this script owns the cluster.
    if (existsSync(envPath) && !existsSync(join(local, 'managed-database'))) {
      throw new Error('backend/.env already exists. Keep your configured database or move that file before using project-local setup.');
    }
    if (!existsSync(envPath)) {
      const password = randomBytes(24).toString('hex');
      writeFileSync(envPath, [
        'NODE_ENV=development', 'HOST=127.0.0.1', `PORT=3001`,
        `DATABASE_URL=postgresql://noteway_user:${password}@127.0.0.1:${port}/noteway`,
        `JWT_SECRET=${randomBytes(32).toString('hex')}`, 'OPENAI_API_KEY=',
        'FRONTEND_ORIGIN=http://localhost:5173',
        `TEST_DATABASE_URL=postgresql://noteway_user:${password}@127.0.0.1:${port}/noteway_test`, '',
      ].join('\n'), { mode: 0o600, flag: 'wx' });
      writeFileSync(join(local, 'managed-database'), '', { mode: 0o600 });
    }
    process.loadEnvFile(envPath);
    const url = new URL(process.env.DATABASE_URL);
    if (url.hostname !== '127.0.0.1' || url.port !== port || url.username !== 'noteway_user' ||
        url.pathname !== '/noteway' || !/^[a-f0-9]{48}$/.test(url.password)) {
      throw new Error('Local setup expects its generated DATABASE_URL. Existing configuration has been left unchanged.');
    }
    if (!existsSync(join(data, 'PG_VERSION'))) {
      run('initdb', ['-D', data, '-U', 'noteway_local_admin', '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256']);
      writeFileSync(join(data, 'postgresql.auto.conf'), [
        "listen_addresses = '127.0.0.1'", `port = ${port}`,
        `unix_socket_directories = '${socket.replaceAll("'", "''")}'`, '',
      ].join('\n'), { mode: 0o600 });
    }
    start();
    // Password is generated hex and validated above. SQL is supplied over stdin.
    if (sql('postgres', "SELECT 1 FROM pg_roles WHERE rolname = 'noteway_user';") !== '1') {
      sql('postgres', `CREATE ROLE noteway_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${url.password}';`);
    }
    for (const database of ['noteway', 'noteway_test']) {
      if (sql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${database}';`) !== '1') {
        sql('postgres', `CREATE DATABASE ${database} OWNER noteway_user;`);
      }
      sql(database, 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;');
    }
    const frontendEnv = join(root, 'frontend/.env.local');
    if (!existsSync(frontendEnv)) writeFileSync(frontendEnv, 'VITE_API_BASE_URL=http://localhost:3001/api\n', { flag: 'wx' });
    console.info('Local development and test databases are ready. Credentials are in backend/.env. Next: npm run migrate:up.');
  }
} catch (error) {
  // Only our own fixed messages should be exposed, not arbitrary subprocess data.
  console.error(error.message.includes('postgres') || error.message.startsWith('Local setup') ||
    error.message.startsWith('backend/.env') || error.message.startsWith('Run npm') ||
    error.message.startsWith('Usage:') || error.message.includes('failed. Check')
    ? error.message : 'Local database setup failed. Check installation and local file permissions.');
  process.exitCode = 1;
}
