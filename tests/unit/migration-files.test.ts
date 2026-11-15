import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertMigrationTransactionBoundary, isMigrationHistoryReady, loadMigrationFiles, pendingMigrations } from '../../src/db/migration-files.js';

const baseline = readFileSync('migrations/0001_initial_schema.sql');
const directories: string[] = [];
function fixture(extra: Record<string, string> = {}) {
  const path = mkdtempSync(join(tmpdir(), 'huahuo-migration-files-')); directories.push(path);
  writeFileSync(join(path, '0001_initial_schema.sql'), baseline);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(path, name), content);
  return path;
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('frozen deployed migration files and append-only history', () => {
  it('plans only the unapplied suffix of the reviewed migration sequence', () => {
    const files = loadMigrationFiles(fixture({ '0002_additive.sql': 'SELECT 2;', '0003_additive.sql': 'SELECT 3;' }));
    expect(files.map(file => file.version)).toEqual([1, 2, 3]);
    expect(pendingMigrations(files, files.slice(0, 2)).map(file => file.version)).toEqual([3]);
    expect(pendingMigrations(files, files)).toEqual([]);
  });

  it('rejects changes to the deployed 0001 even on a fresh database', () => {
    const directory = fixture();
    writeFileSync(join(directory, '0001_initial_schema.sql'), Buffer.concat([baseline, Buffer.from('\n-- edit')]));
    expect(() => loadMigrationFiles(directory)).toThrow('MIGRATION_CHECKSUM_MISMATCH');
  });

  it.each([
    ['malformed SQL filename', { '0002-addition.sql': 'SELECT 2;' }, 'MIGRATION_FILENAME_INVALID'],
    ['duplicate version', { '0002_first.sql': 'SELECT 2;', '0002_second.sql': 'SELECT 3;' }, 'MIGRATION_VERSION_DUPLICATE'],
    ['missing version', { '0003_addition.sql': 'SELECT 3;' }, 'MIGRATION_SEQUENCE_INVALID'],
  ])('rejects %s before any database operation', (_name, extra, code) => {
    expect(() => loadMigrationFiles(fixture(extra))).toThrow(code);
  });

  it('does not read a symlink as reviewed migration content', () => {
    const directory = fixture(); symlinkSync(join(directory, '0001_initial_schema.sql'), join(directory, '0002_alias.sql'));
    expect(() => loadMigrationFiles(directory)).toThrow('MIGRATION_FILENAME_INVALID');
  });

  it('requires the original baseline filename and does not accept an empty catalog', () => {
    const directory = fixture(); rmSync(join(directory, '0001_initial_schema.sql'));
    expect(() => loadMigrationFiles(directory)).toThrow('MIGRATION_BASELINE_REQUIRED');
    writeFileSync(join(directory, '0001_renamed.sql'), baseline);
    expect(() => loadMigrationFiles(directory)).toThrow('MIGRATION_BASELINE_REQUIRED');
  });

  it('rejects missing historical files, gaps and changed incremental checksums', () => {
    const files = loadMigrationFiles(fixture({ '0002_additive.sql': 'SELECT 2;', '0003_additive.sql': 'SELECT 3;' }));
    expect(() => pendingMigrations(files.slice(0, 1), files.slice(0, 2))).toThrow('MIGRATION_HISTORY_UNKNOWN');
    expect(() => pendingMigrations(files, [files[0]!, files[2]!])).toThrow('MIGRATION_HISTORY_GAP');
    expect(() => pendingMigrations(files, [files[0]!, { ...files[1]!, checksum: '0'.repeat(64) }])).toThrow('MIGRATION_CHECKSUM_MISMATCH');
  });

  it('requires every packaged checksum for readiness, while allowing later database migrations for older images', () => {
    const files = loadMigrationFiles(fixture({ '0002_additive.sql': 'SELECT 2;', '0003_additive.sql': 'SELECT 3;' }));
    expect(isMigrationHistoryReady(files.slice(0, 1), files, 1)).toBe(true);
    expect(isMigrationHistoryReady(files.slice(0, 2), [files[0]!, files[2]!], 1)).toBe(false);
    expect(isMigrationHistoryReady(files, [files[0]!, { ...files[1]!, checksum: '0'.repeat(64) }, files[2]!], 1)).toBe(false);
    expect(isMigrationHistoryReady(files, files, 4)).toBe(false);
    expect(isMigrationHistoryReady(files, files, 3)).toBe(true);
  });

  it.each(['BEGIN; SELECT 1; COMMIT;', '-- comment\ncOmMiT;', 'END;', 'START /* comment */ TRANSACTION;',
    "PREPARE TRANSACTION 'name';", 'SAVEPOINT checkpoint;', 'ROLLBACK TO checkpoint;', 'ABORT;', 'RELEASE SAVEPOINT checkpoint;'])(
    'rejects file-owned transaction boundaries: %s', sql => {
    expect(() => assertMigrationTransactionBoundary(sql)).toThrow('MIGRATION_TRANSACTION_CONTROL');
  });

  it.each([
    "SELECT 'BEGIN; COMMIT; ''ROLLBACK'';'; -- END;\nSELECT 1;",
    'SELECT "COMMIT;", "escaped""BEGIN;" FROM example;',
    String.raw`SELECT E'escaped\' COMMIT;'; SELECT 1;`,
    '/* BEGIN; /* COMMIT; */ ROLLBACK; */ SELECT 1;',
    "DO $$ BEGIN PERFORM 'COMMIT;'; END $$;",
    "CREATE FUNCTION example() RETURNS text AS $body$ BEGIN RETURN 'END;'; END $body$ LANGUAGE plpgsql;",
    'PREPARE reviewed_query AS SELECT 1; EXECUTE reviewed_query; DEALLOCATE reviewed_query;',
  ])('allows quoted or procedural transaction words without false positives', sql => {
    expect(() => assertMigrationTransactionBoundary(sql)).not.toThrow();
  });

  it('still detects a top-level commit after a dollar-quoted body or escaped literal', () => {
    expect(() => assertMigrationTransactionBoundary('DO $body$ BEGIN PERFORM 1; END $body$; COMMIT;')).toThrow('MIGRATION_TRANSACTION_CONTROL');
    expect(() => assertMigrationTransactionBoundary(String.raw`SELECT E'escaped\' literal'; COMMIT;`)).toThrow('MIGRATION_TRANSACTION_CONTROL');
    expect(() => loadMigrationFiles(fixture({ '0002_unsafe.sql': 'SELECT 1; COMMIT; SELECT 2;' }))).toThrow('MIGRATION_TRANSACTION_CONTROL');
  });

  it('executes the generator with native Node TypeScript support and rejects unreviewed drafts', async () => {
    // @ts-expect-error This development CLI is intentionally plain JavaScript.
    const { generateMigration } = await import('../../scripts/new-migration.mjs');
    const directory = fixture();
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      'const {generateMigration}=await import(process.argv[1]); console.log(generateMigration("add_probe",process.argv[2]));',
      new URL('../../scripts/new-migration.mjs', import.meta.url).href, directory], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(output.trim()).toBe('0002_add_probe.sql');
    expect(readFileSync(join(directory, '0001_initial_schema.sql'))).toEqual(baseline);
    expect(() => loadMigrationFiles(directory)).toThrow('MIGRATION_DRAFT_NOT_REVIEWED');
    expect(() => generateMigration('../escape', directory)).toThrow('MIGRATION_NAME_INVALID');
    expect(() => generateMigration(resolve(directory, 'escape'), directory)).toThrow('MIGRATION_NAME_INVALID');
    expect(() => generateMigration('another', directory)).toThrow('MIGRATION_DRAFT_NOT_REVIEWED');
    writeFileSync(join(directory, '0002_add_probe.sql'), 'SELECT 2;');
    expect(generateMigration('another', directory)).toBe('0003_another.sql');
    expect(readFileSync(join(directory, '0002_add_probe.sql'), 'utf8')).toBe('SELECT 2;');
    expect(readFileSync(join(directory, '0001_initial_schema.sql'))).toEqual(baseline);
  });
});
