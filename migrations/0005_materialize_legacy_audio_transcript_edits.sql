-- Materialize only transcripts previously edited through the sparse revision table.
WITH edited_assets AS (
  SELECT DISTINCT job.asset_id
  FROM public.funasr_transcript_edits edit
  JOIN public.funasr_jobs job ON job.task_id = edit.task_id
  WHERE job.asset_applied AND job.transcript IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.content_asset_audio_transcripts current
      WHERE current.content_asset_id = job.asset_id
    )
), original_audio AS (
  SELECT asset.content_asset_id, asset.user_id, (array_agg(DISTINCT resource.resource_id))[1] AS resource_id
  FROM edited_assets candidate
  JOIN public.content_assets asset ON asset.content_asset_id = candidate.asset_id
  JOIN public.content_asset_resource_refs ref ON ref.content_asset_id = asset.content_asset_id AND ref.usage = 'original'
  JOIN public.resources resource ON resource.resource_id = ref.resource_id AND resource.user_id = asset.user_id
  WHERE asset.asset_kind = 'audio' AND asset.processing_status = 'ready'
    AND resource.status = 'ready' AND resource.mime_type LIKE 'audio/%'
  GROUP BY asset.content_asset_id, asset.user_id
  HAVING count(DISTINCT resource.resource_id) = 1
), latest_job AS (
  SELECT DISTINCT ON (job.asset_id) job.asset_id, job.resource_id, job.task_id, job.transcript
  FROM original_audio audio
  JOIN public.funasr_jobs job ON job.asset_id = audio.content_asset_id AND job.resource_id = audio.resource_id
  JOIN public.tasks task ON task.id = job.task_id AND task.user_id = audio.user_id
  WHERE job.asset_applied AND job.transcript IS NOT NULL
  ORDER BY job.asset_id, task.created_at DESC, job.task_id DESC
), edited_job AS (
  SELECT job.* FROM latest_job job
  WHERE EXISTS (SELECT 1 FROM public.funasr_transcript_edits edit WHERE edit.task_id = job.task_id)
)
INSERT INTO public.content_asset_audio_transcripts (
  content_asset_id, resource_id, transcription_id, segment_count, content_revision, transcript
)
SELECT job.asset_id, job.resource_id, job.task_id, folded.segment_count, folded.content_revision,
  jsonb_set(jsonb_set(job.transcript, '{segments}', folded.segments), '{text}', to_jsonb(folded.full_text))
FROM edited_job job
CROSS JOIN LATERAL (
  SELECT count(*)::integer AS segment_count, sum(edit.revision) AS content_revision,
    string_agg(coalesce(edit.text, segment.value->>'text'), chr(10) || chr(10) ORDER BY segment.position) AS full_text,
    jsonb_agg(CASE WHEN edit.segment_index IS NULL THEN segment.value ELSE
      segment.value || jsonb_build_object(
        'text', edit.text, 'revision', edit.revision,
        'originalText', coalesce(segment.value->>'originalText', segment.value->>'text')
      ) END ORDER BY segment.position) AS segments
  FROM jsonb_array_elements(job.transcript->'segments') WITH ORDINALITY AS segment(value, position)
  LEFT JOIN public.funasr_transcript_edits edit ON edit.task_id = job.task_id AND edit.segment_index = segment.position - 1
) folded
WHERE folded.content_revision > 0
ON CONFLICT (content_asset_id) DO NOTHING;
