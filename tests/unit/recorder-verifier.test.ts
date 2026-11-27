import { describe, expect, it, vi } from 'vitest';
import { loadRecorderVerifier } from '../../src/config/recorder-verifier.js';
import { HttpRecorderBindingVerifier } from '../../src/modules/recorder-bindings/verifier.js';

const config = { url: 'https://verifier.test/verify', token: 'fixture-token' };
const input = { userId: 'account', deviceId: 'card', proof: 'fixture-proof' };

describe('录音卡首次绑定的受信验证方', () => {
  it('只接受成对配置的认证信息和固定地址', () => {
    expect(loadRecorderVerifier({})).toBeUndefined();
    expect(loadRecorderVerifier({ RECORDER_VERIFIER_URL: config.url, RECORDER_VERIFIER_TOKEN: config.token })).toEqual(config);
    for (const env of [{ RECORDER_VERIFIER_URL: config.url }, { RECORDER_VERIFIER_TOKEN: 'only' },
      { RECORDER_VERIFIER_URL: config.url + '?key=value', RECORDER_VERIFIER_TOKEN: config.token }]) {
      expect(() => loadRecorderVerifier(env)).toThrow('INVALID_CONFIG:RECORDER_VERIFIER');
    }
  });

  it('转发账号、SN 和凭据并使用验证方返回的型号', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ verified: true, deviceId: 'card', modelCode: 'M1' }));
    await expect(new HttpRecorderBindingVerifier(config, request).verify(input)).resolves.toEqual({ deviceId: 'card', modelCode: 'M1' });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(config.url);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + config.token);
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it('区分无效凭据、验证方异常和畸形响应', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ verified: false }))
      .mockResolvedValueOnce(Response.json({ verified: true }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error('offline'));
    const verifier = new HttpRecorderBindingVerifier(config, request);
    await expect(verifier.verify(input)).resolves.toBeNull();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(verifier.verify(input)).rejects.toMatchObject({ code: 'RECORDER_VERIFIER_UNAVAILABLE' });
    }
  });
});
