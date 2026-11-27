import type pg from 'pg';
import { DomainError } from '../identity/store.js';

export const RECORDER_SOURCE_KIND = 'recorder_card';

export interface RecordingUpload {
  bindingId: string;
  recordingKey: string;
}

export function assertRecordingKey(key: string): void {
  // Keep the hardware identifier opaque: no trimming, normalization or truncation.
  if (!key.trim() || Buffer.from(key).toString('utf8') !== key || key.includes('\0') || Buffer.byteLength(key) > 256) {
    throw new DomainError(400, 'RECORDING_KEY_INVALID');
  }
}

export function recorderDevicePrefix(deviceId: string): string {
  return Buffer.from(deviceId).toString('base64url');
}

export function recordingSourceId(deviceId: string, recordingKey: string): string {
  assertRecordingKey(recordingKey);
  return recorderDevicePrefix(deviceId) + '.' + Buffer.from(recordingKey).toString('base64url');
}

export async function recordingStatuses(tx: pg.PoolClient, userId: string, deviceId: string, recordingKeys: string[]) {
  const sourceIds = recordingKeys.map(key => recordingSourceId(deviceId, key));
  const { rows } = await tx.query<{ source_id: string; content_asset_id: string; state: string; resource_id: string | null }>(`
    SELECT a.source_id, a.content_asset_id, a.state, ref.resource_id FROM content_assets a
    LEFT JOIN content_asset_resource_refs ref ON ref.content_asset_id=a.content_asset_id AND ref.usage='original'
    WHERE a.user_id=$1 AND a.source_kind='recorder_card' AND a.source_id=ANY($2::text[])`, [userId, sourceIds]);
  const bySource = new Map(rows.map(row => [row.source_id, row]));
  return recordingKeys.map((recordingKey, i) => {
    const asset = bySource.get(sourceIds[i]!);
    if (!asset) return {recordingKey, status: 'not_synced' as const, contentAssetId: null, resourceId: null};
    if (asset.state === 'deleted') return {recordingKey, status: 'deleted' as const, contentAssetId: asset.content_asset_id, resourceId: null};
    return {recordingKey, status: 'synced' as const, contentAssetId: asset.content_asset_id, resourceId: asset.resource_id};
  });
}
