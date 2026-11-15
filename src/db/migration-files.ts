import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// This exact baseline was deployed at main 1f7adfd. All later changes are additive files.
const BASELINE_CHECKSUM = '5d77ce9faad63e6e1d04b305562367e4264fa69f3cf041cc2ce4100a436015d5';
export interface MigrationFile { version: number; name: string; checksum: string; sql: string; }
export interface MigrationHistory { version: number; checksum: string; }

/** Guard reviewed SQL against accidentally escaping the runner's transaction.
 * This is a small statement lexer, not a SQL security sandbox or full parser.
 * Procedural bodies should use PostgreSQL dollar quoting.
 */
export function assertMigrationTransactionBoundary(sql: string): void {
  let index = 0, words: string[] = [];
  const boundary = () => {
    if (['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE'].includes(words[0] ?? '')
      || (['START', 'PREPARE'].includes(words[0] ?? '') && words[1] === 'TRANSACTION')) {
      throw new Error('MIGRATION_TRANSACTION_CONTROL');
    }
    words = [];
  };
  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/.test(character)) { index++; continue; }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2); index = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new Error('MIGRATION_SQL_UNTERMINATED');
      continue;
    }
    if (character === "'" || character === '"') {
      const escaped = character === "'" && /[eE]/.test(sql[index - 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[index - 2] ?? '');
      let closed = false; index++;
      while (index < sql.length) {
        if (escaped && sql[index] === '\\') { index += 2; continue; }
        if (sql[index] === character) {
          if (sql[index + 1] === character) { index += 2; continue; }
          index++; closed = true; break;
        }
        index++;
      }
      if (!closed) throw new Error('MIGRATION_SQL_UNTERMINATED');
      if (words.length < 2) words.push('#quoted');
      continue;
    }
    if (character === '$' && !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? '')) {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end < 0) throw new Error('MIGRATION_SQL_UNTERMINATED');
        index = end + delimiter.length;
        if (words.length < 2) words.push('#quoted');
        continue;
      }
    }
    if (character === ';') { boundary(); index++; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index))?.[0];
    if (word) {
      if (words.length < 2) words.push(word.toUpperCase());
      index += word.length;
    } else index++;
  }
  boundary();
}

export function loadMigrationFiles(directory = resolve('migrations')): MigrationFile[] {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { throw new Error('MIGRATION_FILES_UNAVAILABLE'); }
  if (!entries.length) throw new Error('MIGRATION_BASELINE_REQUIRED');
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name)) throw new Error('MIGRATION_FILENAME_INVALID');
    let content: Buffer;
    try { content = readFileSync(resolve(directory, entry.name)); }
    catch { throw new Error('MIGRATION_FILES_UNAVAILABLE'); }
    files.push({ version: Number(entry.name.slice(0, 4)), name: entry.name,
      checksum: createHash('sha256').update(content).digest('hex'), sql: content.toString('utf8') });
  }
  files.sort((a, b) => a.version - b.version);
  if (new Set(files.map(file => file.version)).size !== files.length) throw new Error('MIGRATION_VERSION_DUPLICATE');
  if (files[0]?.name !== '0001_initial_schema.sql') throw new Error('MIGRATION_BASELINE_REQUIRED');
  if (files.some((file, index) => file.version !== index + 1)) throw new Error('MIGRATION_SEQUENCE_INVALID');
  if (files[0].checksum !== BASELINE_CHECKSUM) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  for (const file of files) {
    if (file.sql.includes('HUAHUO_MIGRATION_DRAFT')) throw new Error('MIGRATION_DRAFT_NOT_REVIEWED');
    assertMigrationTransactionBoundary(file.sql);
  }
  return files;
}

/** A migration write may only extend the exact, immutable deployed history. */
export function pendingMigrations(files: readonly MigrationFile[], history: readonly MigrationHistory[]): MigrationFile[] {
  const ordered = [...history].sort((a, b) => a.version - b.version);
  for (const [index, row] of ordered.entries()) {
    if (!Number.isInteger(row.version) || row.version < 1 || row.version !== index + 1) throw new Error('MIGRATION_HISTORY_GAP');
    const file = files[index];
    if (!file) throw new Error('MIGRATION_HISTORY_UNKNOWN');
    if (row.checksum !== file.checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  }
  return files.slice(ordered.length);
}

/** Older images accept later migrations, but every migration they ship must match. */
export function isMigrationHistoryReady(files: readonly MigrationFile[], history: readonly MigrationHistory[], minimum: number): boolean {
  const checksums = new Map(history.map(row => [row.version, row.checksum]));
  return files.length > 0 && files.every(file => checksums.get(file.version) === file.checksum)
    && history.some(row => row.version >= minimum);
}
