import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { QuerySendDetailsRequest, SendSmsRequest } from '@alicloud/dysmsapi20170525';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RetryOptions, RuntimeOptions } from '@darabonba/typescript';
import type { AliyunSmsConnection } from '../config/sms.js';
import { maskedPhone, normalizePhone } from '../modules/identity/crypto.js';
import { DomainError } from '../modules/identity/store.js';

// The generated SDK is CommonJS; resolve its constructor consistently in Node ESM and Vitest.
const { default: SmsClient } = createRequire(import.meta.url)('@alicloud/dysmsapi20170525') as typeof import('@alicloud/dysmsapi20170525');
export type AliyunSmsSdk = Pick<InstanceType<typeof SmsClient>, 'sendSmsWithOptions' | 'querySendDetailsWithOptions'>;

export interface TemplateSmsInput {
  phone: string;
  signName: string;
  templateCode: string;
  templateParams?: Record<string, string>;
  outId?: string;
}

export interface SmsDeliveryInput {
  phone: string;
  bizId: string;
  sendDate: string;
  page?: number;
  pageSize?: number;
}

export class SmsProviderError extends Error {
  constructor(
    readonly outcome: 'rejected' | 'unknown',
    readonly providerCode: string,
    readonly providerRequestId?: string,
  ) {
    super(outcome === 'unknown' ? 'SMS_SEND_OUTCOME_UNKNOWN' : 'SMS_PROVIDER_FAILED');
    this.name = 'SmsProviderError';
  }
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9^._:-]{1,128}$/.test(value) ? value : undefined;
}

function providerCode(value: unknown): string {
  if (typeof value !== 'string') return 'Unknown';
  const known = ['InvalidAccessKeyId.NotFound', 'SignatureDoesNotMatch', 'Forbidden.RAM',
    'Forbidden', 'Throttling', 'Throttling.User', 'Throttling.Api', 'InvalidSecurityToken.Expired',
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'TimeoutError', 'RequestTimeout'];
  return known.includes(value) || /^(?:isv|isp)\.[A-Z_]+$/i.test(value) ? value : 'Unknown';
}

function classify(error: unknown): SmsProviderError {
  if (error instanceof SmsProviderError) return error;
  const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const rejected = typeof value.statusCode === 'number' && value.statusCode >= 400 && value.statusCode < 500 && value.statusCode !== 408;
  // SDK exception messages/data can contain the signed request, phone and template variables.
  return new SmsProviderError(rejected ? 'rejected' : 'unknown', providerCode(value.code), identifier(value.requestId));
}

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key))) throw new DomainError(400, 'SMS_INPUT_INVALID');
  return input as Record<string, unknown>;
}

export function prepareTemplateSms(input: unknown): Required<TemplateSmsInput> {
  const value = object(input, ['phone', 'signName', 'templateCode', 'templateParams', 'outId']);
  if (typeof value.phone !== 'string' || typeof value.signName !== 'string'
    || !value.signName.trim() || value.signName.length > 50 || /[\p{Cc}\p{Cf}]/u.test(value.signName)
    || typeof value.templateCode !== 'string' || !/^SMS_\d+$/.test(value.templateCode)
    || (value.outId !== undefined && !identifier(value.outId))) throw new DomainError(400, 'SMS_INPUT_INVALID');
  const params = value.templateParams === undefined ? {} : value.templateParams;
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).length > 20
    || Object.entries(params).some(([key, v]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof v !== 'string' || !v.length || v.length > 512)
    || Buffer.byteLength(JSON.stringify(params)) > 4096) throw new DomainError(400, 'SMS_INPUT_INVALID');
  return {
    phone: normalizePhone(value.phone), signName: value.signName.trim(), templateCode: value.templateCode,
    templateParams: { ...params as Record<string, string> }, outId: value.outId as string | undefined ?? randomUUID(),
  };
}

export function prepareSmsDeliveryQuery(input: unknown): Required<SmsDeliveryInput> {
  const value = object(input, ['phone', 'bizId', 'sendDate', 'page', 'pageSize']);
  if (typeof value.phone !== 'string' || !identifier(value.bizId)
    || typeof value.sendDate !== 'string' || !/^\d{8}$/.test(value.sendDate)) throw new DomainError(400, 'SMS_INPUT_INVALID');
  const date = value.sendDate.slice(0, 4) + '-' + value.sendDate.slice(4, 6) + '-' + value.sendDate.slice(6, 8);
  const parsed = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new DomainError(400, 'SMS_INPUT_INVALID');
  const page = value.page ?? 1, pageSize = value.pageSize ?? 10;
  if (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 10_000
    || !Number.isSafeInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 50) throw new DomainError(400, 'SMS_INPUT_INVALID');
  return { phone: normalizePhone(value.phone), bizId: value.bizId as string, sendDate: value.sendDate, page: Number(page), pageSize: Number(pageSize) };
}

export class AliyunSmsService {
  private readonly sdk: AliyunSmsSdk;

  constructor(private readonly connection: AliyunSmsConnection, sdk?: AliyunSmsSdk) {
    this.sdk = sdk ?? new SmsClient(new $OpenApiUtil.Config({
      accessKeyId: connection.accessKeyId, accessKeySecret: connection.accessKeySecret,
      type: 'access_key', regionId: connection.regionId,
      endpoint: 'dysmsapi.aliyuncs.com', protocol: 'HTTPS',
      userAgent: 'huahuo-server/sms',
      retryOptions: new RetryOptions({ retryable: false }),
    }));
  }

  private runtime() {
    const runtime = new RuntimeOptions({
      connectTimeout: this.connection.connectTimeoutMs, readTimeout: this.connection.readTimeoutMs,
      autoretry: false, maxAttempts: 1, ignoreSSL: false,
    });
    // This SDK's RuntimeOptions constructor omits retryOptions from its property map.
    runtime.retryOptions = new RetryOptions({ retryable: false });
    return runtime;
  }

  async sendTemplate(input: TemplateSmsInput) {
    const message = prepareTemplateSms(input);
    try {
      const response = await this.sdk.sendSmsWithOptions(new SendSmsRequest({
        phoneNumbers: message.phone.slice(3), signName: message.signName, templateCode: message.templateCode,
        templateParam: JSON.stringify(message.templateParams), outId: message.outId,
      }), this.runtime());
      const body = response.body;
      if (!body?.code || (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)))
        throw new SmsProviderError('unknown', 'InvalidResponse');
      if (body.code !== 'OK') throw new SmsProviderError('rejected', providerCode(body.code), identifier(body.requestId));
      if (!identifier(body.bizId) || !identifier(body.requestId)) throw new SmsProviderError('unknown', 'InvalidResponse');
      const acceptedAt = new Date();
      return {
        status: 'accepted' as const, bizId: body.bizId!, requestId: body.requestId!, outId: message.outId,
        phoneMasked: maskedPhone(message.phone), acceptedAt: acceptedAt.toISOString(),
        sendDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(acceptedAt).replaceAll('-', ''),
      };
    } catch (error) { throw classify(error); }
  }

  async queryDelivery(input: SmsDeliveryInput) {
    const query = prepareSmsDeliveryQuery(input);
    try {
      const response = await this.sdk.querySendDetailsWithOptions(new QuerySendDetailsRequest({
        phoneNumber: query.phone.slice(3), bizId: query.bizId, sendDate: query.sendDate,
        currentPage: query.page, pageSize: query.pageSize,
      }), this.runtime());
      const body = response.body;
      if (!body?.code || (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)))
        throw new SmsProviderError('unknown', 'InvalidResponse');
      if (body.code !== 'OK') throw new SmsProviderError('rejected', providerCode(body.code), identifier(body.requestId));
      const totalCount = Number(body.totalCount);
      const details = body.smsSendDetailDTOs?.smsSendDetailDTO ?? [];
      if (!identifier(body.requestId) || body.totalCount === undefined || !Number.isSafeInteger(totalCount) || totalCount < 0
        || !Array.isArray(details) || (totalCount > 0 && !details.length && query.page === 1)) throw new SmsProviderError('unknown', 'InvalidResponse');
      return {
        bizId: query.bizId, requestId: body.requestId!, phoneMasked: maskedPhone(query.phone),
        totalCount, page: query.page, pageSize: query.pageSize,
        records: details.map(detail => {
          if (detail.phoneNum !== query.phone.slice(3)) throw new SmsProviderError('unknown', 'InvalidResponse');
          return {
            status: detail.sendStatus === 1 ? 'sending' as const : detail.sendStatus === 2 ? 'failed' as const : detail.sendStatus === 3 ? 'delivered' as const : 'unknown' as const,
            errorCode: typeof detail.errCode === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(detail.errCode) ? detail.errCode : undefined,
            sendDate: detail.sendDate, receiveDate: detail.receiveDate,
          };
        }),
      };
    } catch (error) { throw classify(error); }
  }
}
