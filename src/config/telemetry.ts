export interface TelemetryConfig { version: string; tracesEndpoint?: string; }

/** No exporter is constructed without the explicit traces endpoint. */
export function loadTelemetryConfig(env: Readonly<Record<string, string | undefined>>, packageVersion: string): TelemetryConfig {
  const version = env.OTEL_SERVICE_VERSION?.trim() || packageVersion;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/.test(version)) throw new Error('INVALID_CONFIG:OTEL_SERVICE_VERSION');
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (!endpoint) return { version };
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash)
      throw new Error('INVALID_ENDPOINT');
    return { version, tracesEndpoint: url.href };
  } catch { throw new Error('INVALID_CONFIG:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'); }
}
