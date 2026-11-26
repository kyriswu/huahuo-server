import { Type } from '@sinclair/typebox';
import { DomainError, type Scope } from '../identity/store.js';
import { Id, Strict } from '../identity/schemas.js';
import type { StorageService } from '../storage/service.js';
import type { ContentAssetService } from './service.js';

export const ContentAssetDisplayContentSchema = Type.Object({
  text: Type.Union([Type.String(), Type.Null()]),
  format: Type.Union([Type.Literal('text'), Type.Literal('markdown'), Type.Null()]),
  resources: Type.Array(Type.Object({
    resourceId: Id, mimeType: Type.String(), usage: Type.String(),
    alt: Type.Union([Type.String(), Type.Null()]), url: Type.Union([Type.String(), Type.Null()]),
    expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  }, Strict)),
  sourceUrl: Type.Optional(Type.String()),
  transcription: Type.Optional(Type.Object({
    transcriptionId: Id, contentRevision: Type.String({ pattern: '^[0-9]+$' }),
    durationMs: Type.Integer({ minimum: 0 }), language: Type.Union([Type.String(), Type.Null()]),
  }, Strict)),
}, Strict);

type Detail = Awaited<ReturnType<ContentAssetService['getContentAsset']>>;

function displaySourceUrl(asset: Omit<Detail, 'audioTranscript'>) {
  if (asset.assetKind !== 'link' && asset.assetKind !== 'file' && asset.assetKind !== 'image') return;
  if (!asset.sourceRef) return;
  try {
    const url = new URL(asset.sourceRef.id);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url.href;
  } catch {
    return undefined;
  }
}

export async function contentAssetDisplayContent(
  storage: StorageService, scope: Scope, asset: Omit<Detail, 'audioTranscript'>, transcript: Detail['audioTranscript'],
) {
  if (asset.state !== 'active' || asset.contentStatus === 'processing' || asset.contentStatus === 'failed') return null;

  const raw = asset.parts.raw?.contentMarkdown ?? '';
  const text = transcript?.text ?? (asset.assetKind === 'creative' || raw.trim() ? raw : null);
  const format = transcript ? 'text' : text === null ? null : 'markdown';
  const sourceUrl = displaySourceUrl(asset);
  const refs = asset.resourceRefs.filter(ref => {
    if (ref.usage === 'inline-image') return false;
    if (asset.assetKind === 'audio') return ref.usage === 'original' && ref.mimeType.startsWith('audio/');
    if (asset.assetKind === 'image') return ref.mimeType.startsWith('image/');
    return true;
  });
  if (text === null && !sourceUrl && refs.length === 0) return null;

  const links = new Map<string, Awaited<ReturnType<StorageService['playbacks']>>[number]>();
  try {
    for (let offset = 0; offset < refs.length; offset += 1000) {
      for (const link of await storage.playbacks(scope, refs.slice(offset, offset + 1000).map(ref => ref.resourceId))) {
        links.set(link.resourceId, link);
      }
    }
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'DIRECT_READ_NOT_CONFIGURED') throw error;
  }

  return {
    text, format,
    resources: refs.map(({ resourceId, mimeType, usage, alt }) => ({
      resourceId, mimeType, usage, alt,
      url: links.get(resourceId)?.url ?? null,
      expiresAt: links.get(resourceId)?.expiresAt ?? null,
    })),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(transcript ? { transcription: {
      transcriptionId: transcript.transcriptionId, contentRevision: transcript.contentRevision,
      durationMs: Math.round(transcript.durationSeconds * 1000), language: transcript.language,
    } } : {}),
  };
}
