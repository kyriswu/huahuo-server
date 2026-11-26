import type pg from 'pg';
import type { ContentStatus } from '../../contracts/content-status.js';
import { idempotent } from '../../lib/idempotency.js';
import { originalAudioResource } from '../content-assets/service.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import { editAudioTranscript, findAudioTranscript, persistAudioTranscript, readAudioTranscriptText, readLegacyAudioTranscript } from './transcript-data.js';

interface Asset {
  title: string;
  source_kind: string;
  created_at: Date;
  processing_status: ContentStatus;
}

export class FunAsrTranscripts {
  constructor(private readonly pool: pg.Pool, private readonly secret: string) {}

  private async readAsset(tx: pg.PoolClient, scope: Scope, id: string, edit = false) {
    await assertScope(tx, scope);
    const asset = (await tx.query<Asset>(`SELECT title,source_kind,created_at,processing_status
      FROM content_assets WHERE content_asset_id=$1 AND user_id=$2 AND state='active' ${edit ? 'FOR UPDATE' : 'FOR SHARE'}`, [id, scope.userId])).rows[0];
    if (!asset) throw new DomainError(404, 'CONTENT_ASSET_NOT_FOUND');

    const resourceId = await originalAudioResource(tx, scope.userId, id) ?? null;
    const ref = asset.processing_status === 'ready' && resourceId
      ? await findAudioTranscript(tx, id, scope.userId, resourceId, edit) : undefined;

    return { asset, resourceId, ref };
  }

  async read(scope: Scope, id: string) {
    return transaction(this.pool, async tx => {
      const { asset, resourceId, ref } = await this.readAsset(tx, scope, id);
      const header = {
        contentAssetId: id, title: asset.title, sourceKind: asset.source_kind,
        createdAt: asset.created_at.toISOString(), contentStatus: asset.processing_status,
        resourceId, transcriptionId: ref?.transcriptionId ?? null,
      };
      if (!ref) return { ...header, durationMs: null, language: null, text: null, contentRevision: null };

      const { text, contentRevision, durationSeconds, language } = await readAudioTranscriptText(tx, ref);
      return {
        ...header, text, contentRevision, durationMs: Math.round(durationSeconds * 1000), language,
      };
    });
  }

  async fullText(scope: Scope, id: string) {
    return transaction(this.pool, async tx => {
      const { ref } = await this.readAsset(tx, scope, id);
      if (!ref) throw new DomainError(404, 'TRANSCRIPT_NOT_FOUND');
      const { text, contentRevision } = await readAudioTranscriptText(tx, ref);
      return { transcriptionId: ref.transcriptionId, text, contentRevision };
    });
  }

  async edit(scope: Scope, id: string, segmentId: string, input: { text: string; revision: number }, key: string) {
    if (input.text.includes('\u0000') || /[\uD800-\uDFFF]/u.test(input.text)) {
      throw new DomainError(400, 'TRANSCRIPT_SEGMENT_TEXT_INVALID');
    }
    return transaction(this.pool, async tx => {
      const { ref, resourceId } = await this.readAsset(tx, scope, id, true);
      const [owner, position] = segmentId.split(':');
      const index = Number(position);
      if (!ref || !resourceId || ref.transcriptionId !== owner || !Number.isSafeInteger(index) || index < 0 || index >= ref.segmentCount) {
        throw new DomainError(404, 'TRANSCRIPT_SEGMENT_NOT_FOUND');
      }
      return idempotent(tx, this.secret, scope.userId, 'content-asset.transcript.edit', key, { id, segmentId, ...input }, async () => {
        if (!ref.persisted) {
          const legacy = await readLegacyAudioTranscript(tx, ref.transcriptionId);
          await persistAudioTranscript(tx, { assetId: id, resourceId, transcriptionId: ref.transcriptionId, ...legacy });
        }
        const result = await editAudioTranscript(tx, { transcriptionId: ref.transcriptionId, index, ...input });
        if (!result) throw new DomainError(409, 'TRANSCRIPT_SEGMENT_REVISION_CONFLICT');
        return { segmentId, ...result };
      });
    });
  }
}
