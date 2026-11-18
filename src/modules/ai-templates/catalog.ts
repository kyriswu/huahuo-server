import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { assertAdminSession, type AdminScope } from '../admin/service.js';
import { DomainError, transaction } from '../identity/store.js';
import { promptVariables, validateCatalog, type Catalog, type SceneKey } from './model.js';

type DraftRow = { draft: Catalog; draft_revision: number; published_revision: number };
type VersionRow = { revision: number; published_at: Date; restored_from: number | null };
type Edit =
  | { action: 'save' | 'publish'; draftRevision: number; catalog: Catalog }
  | { action: 'restore'; draftRevision: number; version: number };

export async function readPublished(tx: pg.PoolClient, scene: SceneKey) {
  const { rows: [version] } = await tx.query<{ catalog: Catalog; revision: number }>(
    'SELECT catalog, revision FROM ai_template_published WHERE scene_key=$1', [scene],
  );
  if (!version) throw new DomainError(503, 'AI_TEMPLATE_CATALOG_UNAVAILABLE');
  return version;
}

export class AiTemplateCatalog {
  constructor(private readonly pool: pg.Pool) {}

  private async view(tx: pg.PoolClient, scene: SceneKey) {
    const { rows: [row] } = await tx.query<DraftRow & { has_unpublished_draft: boolean }>(
      `SELECT s.draft, s.draft_revision, s.published_revision, s.draft IS DISTINCT FROM v.catalog AS has_unpublished_draft
       FROM ai_template_scenes s JOIN ai_template_versions v ON v.scene_key=s.scene_key AND v.revision=s.published_revision
       WHERE s.scene_key=$1`, [scene],
    );
    if (!row) throw new DomainError(503, 'AI_TEMPLATE_CATALOG_UNAVAILABLE');
    const { rows: history } = await tx.query<VersionRow>(
      `SELECT revision, published_at, restored_from FROM ai_template_versions
       WHERE scene_key=$1 ORDER BY revision DESC LIMIT 30`, [scene],
    );
    return {
      sceneKey: scene,
      draft: row.draft,
      draftRevision: row.draft_revision,
      publishedRevision: row.published_revision,
      hasUnpublishedDraft: row.has_unpublished_draft,
      variables: scene === 'note_outline' ? [...promptVariables] : ['templateTitle'],
      history: history.map(version => ({
        version: version.revision, publishedAt: version.published_at.toISOString(), restoredFrom: version.restored_from,
      })),
    };
  }

  get(scene: SceneKey, scope: AdminScope) {
    return transaction(this.pool, async tx => {
      // Keep the draft and history on the same database snapshot.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await assertAdminSession(tx, scope);
      return this.view(tx, scene);
    });
  }

  edit(scene: SceneKey, scope: AdminScope, edit: Edit, traceId: string) {
    return transaction(this.pool, async tx => {
      await assertAdminSession(tx, scope);
      const { rows: [current] } = await tx.query<Pick<DraftRow, 'draft_revision' | 'published_revision'>>(
        'SELECT draft_revision, published_revision FROM ai_template_scenes WHERE scene_key=$1 FOR UPDATE', [scene],
      );
      if (!current) throw new DomainError(503, 'AI_TEMPLATE_CATALOG_UNAVAILABLE');
      if (current.draft_revision !== edit.draftRevision) throw new DomainError(409, 'AI_TEMPLATE_DRAFT_CONFLICT');

      let catalog: Catalog;
      const restoredFrom = edit.action === 'restore' ? edit.version : null;
      if (edit.action === 'restore') {
        const { rows: [version] } = await tx.query<{ catalog: Catalog }>(
          'SELECT catalog FROM ai_template_versions WHERE scene_key=$1 AND revision=$2', [scene, edit.version],
        );
        if (!version) throw new DomainError(404, 'AI_TEMPLATE_VERSION_NOT_FOUND');
        catalog = version.catalog;
      } else {
        catalog = edit.catalog;
      }
      validateCatalog(scene, catalog, edit.action !== 'save');

      let publishedRevision = current.published_revision;
      if (edit.action !== 'save') {
        publishedRevision++;
        await tx.query(
          `INSERT INTO ai_template_versions (scene_key, revision, catalog, published_by, restored_from)
           VALUES ($1, $2, $3, $4, $5)`, [scene, publishedRevision, catalog, scope.adminId, restoredFrom],
        );
      }
      await tx.query(
        `UPDATE ai_template_scenes SET draft=$2, draft_revision=draft_revision+1, published_revision=$3
         WHERE scene_key=$1`, [scene, catalog, publishedRevision],
      );
      await tx.query(
        `INSERT INTO admin_audit_events (id, admin_id, action, target_id, reason, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), scope.adminId, `ai_template.${edit.action}`, scene,
          JSON.stringify({ draftRevision: edit.draftRevision + 1, publishedRevision, restoredFrom }), traceId],
      );
      return this.view(tx, scene);
    });
  }
}
