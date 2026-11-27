import { describe, expect, it, vi } from 'vitest';
import { loadRecordingOutlineConfig } from '../../src/config/recording-outline.js';
import { ServiceHttpClient } from '../../src/integrations/http-client.js';
import { ServiceRecordingOutlineProvider } from '../../src/modules/funasr/outline-provider.js';

describe('background recording outline transport', () => {
  const settings = {url:'http://outline.internal/internal/outline', token:'test-service-token'};
  it('requires an explicit pair of fixed service URL and token', () => {
    expect(loadRecordingOutlineConfig({})).toBeUndefined();
    expect(() => loadRecordingOutlineConfig({RECORDING_OUTLINE_SERVICE_URL: settings.url})).toThrow('TOKEN');
    expect(() => loadRecordingOutlineConfig({RECORDING_OUTLINE_SERVICE_URL:'http://user:password@example.test',RECORDING_OUTLINE_SERVICE_TOKEN:'abc'})).toThrow('URL');
    expect(loadRecordingOutlineConfig({RECORDING_OUTLINE_SERVICE_URL:settings.url,RECORDING_OUTLINE_SERVICE_TOKEN:settings.token})).toEqual(settings);
  });
  it('uses only a service principal and a stable run key with redirects disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({text:'提要'}));
    const provider = new ServiceRecordingOutlineProvider(settings,new ServiceHttpClient({fetchImpl}));
    await expect(provider.generate('run-7',{prompt:'总结',text:'原文'},new AbortController().signal)).resolves.toBe('提要');
    const [url,request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(settings.url);
    expect(request).toMatchObject({method:'POST',redirect:'error'});
    const headers = new Headers(request!.headers);
    expect(headers.get('x-idempotency-key')).toBe('run-7');
    expect(headers.get('authorization')).toBe('Bearer test-service-token');
    expect(headers.has('x-huahuo-session-id')).toBe(false);
    expect(JSON.parse(request!.body as string)).toEqual({prompt:'总结',text:'原文',stream:false});
  });
  it('preserves the run key after a 200 response without usable output', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({unexpected:'payload'}))
      .mockResolvedValueOnce(Response.json({text:'已保存的结果'}));
    const provider = new ServiceRecordingOutlineProvider(settings,new ServiceHttpClient({fetchImpl}));
    const run = () => provider.generate('unchanged-run',{prompt:'总结',text:'原文'},new AbortController().signal);
    await expect(run()).rejects.toMatchObject({code:'AI_TEMPLATE_AGENT_RESPONSE_INVALID'});
    await expect(run()).resolves.toBe('已保存的结果');
    expect(fetchImpl.mock.calls.map(([,request]) => new Headers(request?.headers).get('x-idempotency-key')))
      .toEqual(['unchanged-run','unchanged-run']);
  });
  it('distinguishes admission failure and an indeterminate submission', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null,{status:403}))
      .mockResolvedValueOnce(new Response(null,{status:502}));
    const provider = new ServiceRecordingOutlineProvider(settings,new ServiceHttpClient({fetchImpl}));
    const call = () => provider.generate('run',{prompt:'总结',text:'原文'},new AbortController().signal);
    await expect(call()).rejects.toMatchObject({code:'RECORDING_OUTLINE_PROVIDER_REJECTED'});
    await expect(call()).rejects.toMatchObject({code:'RECORDING_OUTLINE_OUTCOME_UNKNOWN'});
  });
});
