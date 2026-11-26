import type pg from 'pg';
import { DomainError } from '../identity/store.js';

export interface StoredTranscript {
  text: string;
  durationSeconds: number;
  language?: string;
  speakers?: { speakerId: string; personId?: string; displayName?: string }[];
  segments: {
    startMs: number;
    endMs: number;
    speakerId: string | null;
    text: string;
    originalText?: string;
    revision?: number;
  }[];
}

export interface AudioTranscriptRef {
  transcriptionId: string;
  segmentCount: number;
  persisted: boolean;
}

interface AudioTranscript {
  transcript: StoredTranscript;
  contentRevision: string;
}

export async function findAudioTranscript(tx: pg.PoolClient, assetId: string, userId: string, resourceId: string, includeSegmentCount: boolean) {
  const current = (await tx.query<AudioTranscriptRef>(`
    SELECT current.transcription_id AS "transcriptionId", current.segment_count AS "segmentCount", true AS persisted
    FROM content_asset_audio_transcripts current
    JOIN content_assets asset ON asset.content_asset_id=current.content_asset_id AND asset.user_id=$2
    WHERE current.content_asset_id=$1 AND current.resource_id=$3`, [assetId, userId, resourceId])).rows[0];
  if (current) return current;

  return (await tx.query<AudioTranscriptRef>(`
    SELECT j.task_id AS "transcriptionId",
      CASE WHEN $4::boolean THEN coalesce(j.segment_count,jsonb_array_length(j.transcript->'segments')) ELSE 0 END AS "segmentCount",
      false AS persisted
    FROM funasr_jobs j JOIN tasks t ON t.id=j.task_id AND t.user_id=$2
    WHERE j.asset_id=$1 AND j.resource_id=$3 AND j.asset_applied AND j.transcript IS NOT NULL
    ORDER BY t.created_at DESC,j.task_id DESC LIMIT 1`, [assetId, userId, resourceId, includeSegmentCount])).rows[0];
}

export async function readLegacyAudioTranscript(tx: pg.PoolClient, transcriptionId: string): Promise<AudioTranscript> {
  const legacy = (await tx.query<{
    transcript: StoredTranscript;
    edits: { segment_index: number; text: string; revision: number }[];
  }>(`
    SELECT j.transcript, coalesce((
      SELECT jsonb_agg(jsonb_build_object('segment_index', e.segment_index, 'text', e.text, 'revision', e.revision))
      FROM funasr_transcript_edits e WHERE e.task_id=j.task_id
    ), '[]'::jsonb) AS edits
    FROM funasr_jobs j WHERE j.task_id=$1 AND j.transcript IS NOT NULL`, [transcriptionId])).rows[0];
  if (!legacy) throw new DomainError(404, 'TRANSCRIPT_NOT_FOUND');

  const { transcript } = legacy;
  let contentRevision = 0n;
  for (const edit of legacy.edits) {
    const prior = transcript.segments[edit.segment_index];
    if (!prior) continue;
    transcript.segments[edit.segment_index] = {
      ...prior, originalText: prior.originalText ?? prior.text, text: edit.text, revision: edit.revision,
    };
    contentRevision += BigInt(edit.revision);
  }
  if (contentRevision > 0n) transcript.text = transcript.segments.map(segment => segment.text).join('\n\n');
  return { transcript, contentRevision: String(contentRevision) };
}

export async function readAudioTranscriptText(tx: pg.PoolClient, ref: AudioTranscriptRef) {
  const source = ref.persisted ? 'content_asset_audio_transcripts WHERE transcription_id=$1'
    : 'funasr_jobs WHERE task_id=$1 AND transcript IS NOT NULL';
  const revision = ref.persisted ? 'content_revision::text' : "'0'";
  const row = (await tx.query<{ text: string; contentRevision: string; durationSeconds: number; language: string | null }>(`
    SELECT transcript->>'text' AS text, ${revision} AS "contentRevision",
      (transcript->>'durationSeconds')::double precision AS "durationSeconds", transcript->>'language' AS language
    FROM ${source}`, [ref.transcriptionId])).rows[0];
  if (!row) throw new DomainError(404, 'TRANSCRIPT_NOT_FOUND');
  return row;
}

export async function persistAudioTranscript(tx: pg.PoolClient, input: {
  assetId: string; resourceId: string; transcriptionId: string; transcript: StoredTranscript; contentRevision?: string;
}) {
  await tx.query(`
    INSERT INTO content_asset_audio_transcripts(content_asset_id,resource_id,transcription_id,segment_count,content_revision,transcript)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT (content_asset_id) DO UPDATE SET resource_id=excluded.resource_id,
      transcription_id=excluded.transcription_id,segment_count=excluded.segment_count,
      content_revision=excluded.content_revision,transcript=excluded.transcript`,
  [input.assetId, input.resourceId, input.transcriptionId, input.transcript.segments.length,
    input.contentRevision ?? '0', JSON.stringify(input.transcript)]);
}

export async function editAudioTranscript(tx: pg.PoolClient, input: {
  transcriptionId: string; index: number; text: string; revision: number;
}) {
  return (await tx.query<{ text: string; revision: number }>(`
    WITH previous AS (
      SELECT transcript, transcript->'segments'->$2::integer AS segment
      FROM content_asset_audio_transcripts WHERE transcription_id=$1 AND $2::integer >= 0 FOR UPDATE
    ), edited AS (
      SELECT jsonb_set(transcript, ARRAY['segments', $2::integer::text],
        segment || jsonb_build_object('text', $3::text, 'revision', $4::integer+1,
          'originalText', coalesce(segment->>'originalText', segment->>'text')), false) AS transcript
      FROM previous WHERE segment IS NOT NULL AND coalesce((segment->>'revision')::integer, 0)=$4::integer
    ), full_text AS (
      SELECT edited.transcript, (
        SELECT string_agg(segment.item->>'text', chr(10)||chr(10) ORDER BY segment.position)
        FROM jsonb_array_elements(edited.transcript->'segments') WITH ORDINALITY AS segment(item,position)
      ) AS text FROM edited
    )
    UPDATE content_asset_audio_transcripts current SET
      transcript=jsonb_set(full_text.transcript, '{text}', to_jsonb(full_text.text), false),
      content_revision=current.content_revision+1
    FROM full_text WHERE current.transcription_id=$1
    RETURNING $3::text AS text, $4::integer+1 AS revision`,
  [input.transcriptionId, input.index, input.text, input.revision])).rows[0];
}
