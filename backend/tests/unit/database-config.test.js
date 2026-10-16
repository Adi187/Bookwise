import { describe, expect, it } from 'vitest';
import { readDatabaseUrl } from '../../src/config/env.js';

describe('database connection configuration', () => {
  it('preserves an encoded password for the PostgreSQL driver', () => {
    const url = 'postgresql://noteway_user:test%40password%23@localhost:5432/noteway';
    expect(readDatabaseUrl(url)).toBe(url);
  });

  it.each([
    undefined,
    'postgresql://localhost/noteway',
    'postgresql://noteway_user@localhost/noteway',
    'postgresql://:password@localhost/noteway',
    'postgresql://noteway_user:replace_me@localhost/noteway',
    'postgresql://noteway_user:replace%5Fme@localhost/noteway',
    'https://noteway_user:password@localhost/noteway',
    'postgresql://noteway_user:password@localhost/',
  ])('rejects missing or invalid credentials without echoing the URL', (url) => {
    expect(() => readDatabaseUrl(url)).toThrow('DATABASE_URL must be a PostgreSQL connection URL');
    try {
      readDatabaseUrl(url);
    } catch (error) {
      if (url) expect(error.message).not.toContain(url);
    }
  });

  it('identifies invalid migration configuration without leaking its password', () => {
    expect(() => readDatabaseUrl('invalid://owner:private-secret@localhost/noteway', 'MIGRATION_DATABASE_URL'))
      .toThrow('MIGRATION_DATABASE_URL must be a PostgreSQL connection URL');
  });
});
