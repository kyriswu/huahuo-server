export function embeddingProfileFor(model: string, dimensions: number): string {
  const normalized = model.trim().toLowerCase();
  const base = normalized.includes('qwen3-embedding-8b')
    ? 'qwen3-embedding-8b'
    : normalized.includes('bge-m3')
      ? 'bge-m3'
      : normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'embedding';
  return `${base}-${dimensions}`;
}

export function documentKeyForVersion(versionId: string): string { return versionId; }
export function indexBuildIdForVersion(versionId: string, embeddingProfile: string): string { return `${versionId}-${embeddingProfile}`; }
