import { DomainError } from '../modules/identity/store.js';
import type { AppConfig } from '../config/config.js';
import type { AliyunOtpConfig } from '../config/sms.js';
import { AliyunSmsService } from './aliyun-sms.js';
export interface SmsMessage { phone: string; code: string; purpose: 'sign_in'; requestId: string; }
export interface SmsProvider { readonly mode: 'mock' | 'live' | 'disabled'; send(message: SmsMessage): Promise<void>; }
export class MockSmsProvider implements SmsProvider {
  readonly mode = 'mock';
  async send(_message: SmsMessage) { void _message; /* Explicit local simulation: no network or success claim about SMS delivery. */ }
}
export class DisabledSmsProvider implements SmsProvider {
  readonly mode = 'disabled';
  async send(_message: SmsMessage): Promise<void> { void _message; throw new DomainError(503,'SMS_NOT_CONFIGURED'); }
}
export class AliyunSmsProvider implements SmsProvider {
  readonly mode = 'live';
  constructor(private readonly config: AliyunOtpConfig, private readonly service = new AliyunSmsService(config)) {}
  async send(message: SmsMessage): Promise<void> {
    if (message.purpose !== 'sign_in' || !/^\d{6}$/.test(message.code)) throw new DomainError(400, 'SMS_INPUT_INVALID');
    await this.service.sendTemplate({
      phone: message.phone, signName: this.config.signName, templateCode: this.config.templateCode,
      templateParams: { [this.config.codeParam]: message.code }, outId: message.requestId,
    });
  }
}
export function createSmsProvider(config: Pick<AppConfig, 'smsProvider' | 'smsAliyun'>): SmsProvider {
  if (config.smsProvider === 'mock') return new MockSmsProvider();
  if (config.smsProvider === 'disabled') return new DisabledSmsProvider();
  if (!config.smsAliyun) throw new Error('INVALID_CONFIG:SMS_ALIYUN');
  return new AliyunSmsProvider(config.smsAliyun);
}
