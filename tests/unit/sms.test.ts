import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { QuerySendDetailsResponse, QuerySendDetailsResponseBody, QuerySendDetailsResponseBodySmsSendDetailDTOs, QuerySendDetailsResponseBodySmsSendDetailDTOsSmsSendDetailDTO, SendSmsResponse, SendSmsResponseBody } from '@alicloud/dysmsapi20170525';
import { loadConfig } from '../../src/config/config.js';
import { loadAliyunOtpConfig, loadAliyunSmsConnection } from '../../src/config/sms.js';
import { AliyunSmsService, prepareSmsDeliveryQuery, prepareTemplateSms, type AliyunSmsSdk } from '../../src/integrations/aliyun-sms.js';
import { AliyunSmsProvider, createSmsProvider } from '../../src/integrations/sms.js';
import { executeSmsCommand, readSmsToolInput, smsToolError } from '../../src/tools/sms.js';
import { env } from '../helpers.js';

const credentials = { ALIYUN_RAM_ACCESS_KEY_ID: 'fixture-access-id', ALIYUN_RAM_ACCESS_KEY_SECRET: 'fixture-access-secret' };
const configured = { ...env, ...credentials, SMS_ALIYUN_SIGN_NAME: '花火测试', SMS_ALIYUN_TEMPLATE_CODE: 'SMS_123456', SMS_ALIYUN_CODE_PARAM: 'verification' };
const otpConfig = loadAliyunOtpConfig(configured);
const requestId = '386a8301-31ba-46e9-951f-5b9ae36081aa';
const input = { phone: '13800000001', signName: '花火测试', templateCode: 'SMS_123456', templateParams: { verification: '001234' }, outId: requestId };

function fixture(status = 3) {
  const send = vi.fn<AliyunSmsSdk['sendSmsWithOptions']>().mockResolvedValue(new SendSmsResponse({
    statusCode: 200, body: new SendSmsResponseBody({ code: 'OK', bizId: '123^456', requestId }),
  }));
  const query = vi.fn<AliyunSmsSdk['querySendDetailsWithOptions']>().mockResolvedValue(new QuerySendDetailsResponse({
    statusCode: 200, body: new QuerySendDetailsResponseBody({
      code: 'OK', requestId, totalCount: '1', smsSendDetailDTOs: new QuerySendDetailsResponseBodySmsSendDetailDTOs({
        smsSendDetailDTO: [new QuerySendDetailsResponseBodySmsSendDetailDTOsSmsSendDetailDTO({
          phoneNum: '13800000001', sendStatus: status, errCode: 'DELIVERED', content: 'Private code: 001234',
          sendDate: '2026-11-12 12:00:00', receiveDate: '2026-11-12 12:00:01',
        })],
      }),
    }),
  }));
  const service = new AliyunSmsService(otpConfig, { sendSmsWithOptions: send, querySendDetailsWithOptions: query });
  return { send, query, service };
}

afterEach(() => vi.useRealTimers());

describe('Aliyun SMS configuration', () => {
  it('checks the actual five-role release configuration without network access', () => {
    const assertion=new Script(readFileSync('scripts/release/changes/20261117-sms-live-only/verify-config.mjs','utf8'));
    const api={...credentials,SERVICE_ROLE:'api-server',SMS_ALIYUN_SIGN_NAME:'触达科技',SMS_ALIYUN_TEMPLATE_CODE:'SMS_508520316',SMS_ALIYUN_CODE_PARAM:'code',SMS_ALIYUN_REGION_ID:'cn-hangzhou',SMS_ALIYUN_CONNECT_TIMEOUT_MS:'3000',SMS_ALIYUN_READ_TIMEOUT_MS:'3000'};
    const verify=(env:Record<string,string>)=>assertion.runInNewContext({process:{env}});
    expect(()=>verify(api)).not.toThrow();
    for(const role of ['admin','worker','scheduler','migrate'])expect(()=>verify({SERVICE_ROLE:role})).not.toThrow();
    for(const patch of [{SMS_PROVIDER:'live'},{SHOW_TEST_OTP:'false'},{SMS_ALIYUN_TEMPLATE_CODE:'SMS_123456'},{SMS_ALIYUN_CODE_PARAM:'wrong'},{ALIYUN_RAM_ACCESS_KEY_ID:''},{SERVICE_ROLE:'unknown'}])expect(()=>verify({...api,...patch})).toThrow('SMS_RELEASE_CONFIGURATION_INVALID');
  });
  it('requires a complete live configuration only for the API role and uses the shared RAM keys', () => {
    expect(loadConfig('api-server', configured).smsAliyun).toEqual(otpConfig);
    for (const key of ['ALIYUN_RAM_ACCESS_KEY_ID', 'ALIYUN_RAM_ACCESS_KEY_SECRET', 'SMS_ALIYUN_SIGN_NAME', 'SMS_ALIYUN_TEMPLATE_CODE']) {
      expect(() => loadConfig('api-server', { ...configured, [key]: '' })).toThrow('INVALID_CONFIG:' + key);
    }
    for (const role of ['admin', 'worker', 'scheduler', 'migrate'] as const) {
      expect(loadConfig(role, { ...env, ALIYUN_RAM_ACCESS_KEY_ID: '', ALIYUN_RAM_ACCESS_KEY_SECRET: '' }).smsAliyun).toBeUndefined();
    }
    for (const appEnv of ['development', 'test', 'production']) {
      const runtime = { ...configured, APP_ENV: appEnv, DATABASE_SSL_MODE: 'verify-full', APP_PUBLIC_BASE_URL: 'https://api.example.test', APP_JWT_PRIVATE_KEY: 'cA==', APP_JWT_PUBLIC_KEY: 'cA==' };
      expect(createSmsProvider(loadConfig('api-server', runtime))).toBeInstanceOf(AliyunSmsProvider);
      expect(() => loadConfig('api-server', { ...runtime, SMS_ALIYUN_TEMPLATE_CODE: '' })).toThrow('INVALID_CONFIG:SMS_ALIYUN_TEMPLATE_CODE');
    }
    expect(createSmsProvider(loadConfig('api-server', configured))).toBeInstanceOf(AliyunSmsProvider);
    expect(loadAliyunSmsConnection(credentials)).toMatchObject({ accessKeyId: credentials.ALIYUN_RAM_ACCESS_KEY_ID, readTimeoutMs: 3000 });
  });

  it.each([
    { SMS_ALIYUN_TEMPLATE_CODE: 'invalid' }, { SMS_ALIYUN_CODE_PARAM: '__proto__' },
    { SMS_ALIYUN_SIGN_NAME: 'bad\nsign' }, { SMS_ALIYUN_REGION_ID: 'https://other.test' },
    { SMS_ALIYUN_READ_TIMEOUT_MS: '0' }, { SMS_ALIYUN_CONNECT_TIMEOUT_MS: '30001' },
  ])('rejects invalid live settings without exposing their values: %j', patch => {
    expect(() => loadAliyunOtpConfig({ ...configured, ...patch })).toThrow(/^INVALID_CONFIG:/);
  });
});

describe('official SMS SDK adapter (mock cloud responses)', () => {
  it('sends one normalized number, preserves leading zeroes, disables both SDK retry mechanisms and reports gateway acceptance', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-11-12T16:10:00Z'));
    const { service, send } = fixture();
    const receipt = await service.sendTemplate({ ...input, phone: '+8613800000001' });
    expect(send).toHaveBeenCalledTimes(1);
    const [request, runtime] = send.mock.calls[0]!;
    expect(request).toMatchObject({ phoneNumbers: '13800000001', signName: '花火测试', templateCode: 'SMS_123456',
      templateParam: '{"verification":"001234"}', outId: requestId });
    expect(runtime).toMatchObject({ autoretry: false, maxAttempts: 1, retryOptions: { retryable: false }, ignoreSSL: false, readTimeout: 3000 });
    expect(receipt).toMatchObject({ status: 'accepted', bizId: '123^456', phoneMasked: '138****0001', sendDate: '20261113' });
    expect(JSON.stringify(receipt)).not.toContain('001234');
  });

  it('maps the server-generated OTP to the configured template variable', async () => {
    const f = fixture(), provider = new AliyunSmsProvider(otpConfig, f.service);
    await provider.send({ phone: '+8613800000001', code: '001234', purpose: 'sign_in', requestId });
    expect(f.send.mock.calls[0]![0].templateParam).toBe('{"verification":"001234"}');
    await expect(provider.send({ phone: '+8613800000001', code: 'bad', purpose: 'sign_in', requestId })).rejects.toMatchObject({ code: 'SMS_INPUT_INVALID' });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a business failure even with HTTP 200 and hides the provider message', async () => {
    const { service, send } = fixture();
    send.mockResolvedValueOnce(new SendSmsResponse({ statusCode: 200, body: new SendSmsResponseBody({
      code: 'isv.BUSINESS_LIMIT_CONTROL', requestId, message: 'private phone=13800000001 and code=001234',
    }) }));
    const error = await service.sendTemplate(input).catch(error => error);
    expect(error).toMatchObject({ outcome: 'rejected', providerCode: 'isv.BUSINESS_LIMIT_CONTROL', providerRequestId: requestId });
    expect(JSON.stringify(smsToolError(error))).not.toMatch(/13800000001|001234/);
  });

  it.each([{}, { code: 'OK' }, { code: 'OK', bizId: '123^456' }])('treats incomplete success as unknown and never retries: %j', async body => {
    const { service, send } = fixture();
    send.mockResolvedValueOnce(new SendSmsResponse({ statusCode: 200, body: new SendSmsResponseBody(body) }));
    await expect(service.sendTemplate(input)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not retry a timeout or expose SDK exception data', async () => {
    const { service, send } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error('signed URL with fixture-access-secret and code=001234'), {
      code: 'ETIMEDOUT', data: { accessKeyId: credentials.ALIYUN_RAM_ACCESS_KEY_ID },
    }));
    const error = await service.sendTemplate(input).catch(error => error);
    expect(smsToolError(error)).toEqual({ code: 'SMS_SEND_OUTCOME_UNKNOWN', outcome: 'unknown', providerCode: 'ETIMEDOUT', providerRequestId: undefined });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(smsToolError(error))).not.toMatch(/fixture-access|001234/);
  });

  it('uses BizId and the domestic phone format to query delivery, omitting message content', async () => {
    const { service, query, send } = fixture();
    const result = await service.queryDelivery({ phone: '+8613800000001', bizId: '123^456', sendDate: '20261112' });
    expect(query.mock.calls[0]![0]).toMatchObject({ phoneNumber: '13800000001', bizId: '123^456', sendDate: '20261112', currentPage: 1, pageSize: 10 });
    expect(result.records[0]).toMatchObject({ status: 'delivered', errorCode: 'DELIVERED' });
    expect(JSON.stringify(result)).not.toMatch(/Private code|001234|13800000001/);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([1, 2, 9])('does not label non-delivered carrier status %s as delivered', async status => {
    const { service } = fixture(status);
    const result = await service.queryDelivery({ phone: input.phone, bizId: '123^456', sendDate: '20261112' });
    expect(result.records[0]!.status).toBe(status === 1 ? 'sending' : status === 2 ? 'failed' : 'unknown');
  });
});

describe('SMS tool input and execution', () => {
  it.each([
    { ...input, phone: '13800000001,13900000001' }, { ...input, phone: '+15551234567' },
    { ...input, signName: '' }, { ...input, templateCode: 'SMS_fake' },
    { ...input, templateParams: { code: { nested: 'bad' } } },
    { ...input, endpoint: 'https://other.test' },
  ])('rejects invalid or extra send inputs before a network call: %j', bad => {
    expect(() => prepareTemplateSms(bad)).toThrow();
  });

  it('validates calendar dates, query pagination and a required BizId', () => {
    for (const patch of [{ sendDate: '20260230' }, { bizId: '' }, { pageSize: 51 }, { page: 0 }]) {
      expect(() => prepareSmsDeliveryQuery({ phone: input.phone, bizId: '123^456', sendDate: '20261112', ...patch })).toThrow();
    }
  });

  it('previews without credentials or network calls and masks template values', async () => {
    const factory = vi.fn();
    const preview = await executeSmsCommand('preview', input, {}, factory);
    expect(preview).toMatchObject({ status: 'preview', phoneMasked: '138****0001', templateParamNames: ['verification'] });
    expect(JSON.stringify(preview)).not.toMatch(/001234|13800000001/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('requires credentials for a manual send and reuses the same service for send/query', async () => {
    const f = fixture(), factory = vi.fn(() => f.service);
    await expect(executeSmsCommand('send', input, {}, factory)).rejects.toThrow('INVALID_CONFIG:ALIYUN_RAM_ACCESS_KEY_ID');
    expect(factory).not.toHaveBeenCalled();
    expect(await executeSmsCommand('send', input, configured, factory)).toMatchObject({ status: 'accepted' });
    expect(await executeSmsCommand('query', { phone: input.phone, bizId: '123^456', sendDate: '20261112' }, credentials, factory)).toMatchObject({ totalCount: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('reads bounded JSON from stdin and does not echo parse errors or arbitrary exceptions', async () => {
    async function* chunks(value: string) { yield Buffer.from(value); }
    expect(await readSmsToolInput(chunks(JSON.stringify(input)))).toEqual(input);
    await expect(readSmsToolInput(chunks('private invalid JSON'))).rejects.toMatchObject({ code: 'SMS_INPUT_INVALID_JSON' });
    await expect(readSmsToolInput(chunks('x'.repeat(8193)))).rejects.toMatchObject({ code: 'SMS_INPUT_TOO_LARGE' });
    expect(smsToolError(new Error('secret request or credentials'))).toEqual({ code: 'SMS_TOOL_FAILED' });
  });
});
