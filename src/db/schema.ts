import { pgTable, integer, text, timestamp } from 'drizzle-orm/pg-core';
export const schemaMigrations = pgTable('schema_migrations', {
  version: integer().primaryKey(), checksum: text().notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});
