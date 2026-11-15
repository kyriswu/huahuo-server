import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMigrationFiles } from '../src/db/migration-files.ts';

export function generateMigration(name, directory = resolve('migrations')) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{2,64}$/.test(name)) throw new Error('MIGRATION_NAME_INVALID');
  const files = loadMigrationFiles(directory);
  const next = files.at(-1).version + 1;
  if (next > 9999) throw new Error('MIGRATION_VERSION_EXHAUSTED');
  const filename = `${String(next).padStart(4, '0')}_${name}.sql`;
  writeFileSync(resolve(directory, filename), `-- HUAHUO_MIGRATION_DRAFT
-- Fill in SQL and remove the draft marker after review. Never edit an applied file.
-- Purpose / old-version compatibility:
-- Data changes: none, bounded inline (explain size/lock/time), or separate job:
-- Failure/retry: one file is one transaction; do not add BEGIN/COMMIT/ROLLBACK.
-- Include needed ordinary indexes and role grants; no physical foreign keys.
-- Add this filename and read-only verify-db.sql to scripts/release/plan.json.
-- Rehearse against the deployed baseline, including old and candidate code.
`, { flag: 'wx' });
  return filename;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('MIGRATION_NAME_INVALID');
    console.log('migrations/' + generateMigration(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error && /^MIGRATION_[A-Z_]+$/.test(error.message) ? error.message : 'MIGRATION_GENERATION_FAILED');
    process.exitCode = 1;
  }
}
