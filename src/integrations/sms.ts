import { DomainError } from '../modules/identity/store.js';
import type { AppConfig } from '../config/config.js';
import type { AliyunOtpConfig } from '../config/sms.js';
import { AliyunSmsService } from './aliyun-sms.js';
export interface SmsMessage { phone: string; code: string; purpose: 'sign_in'; requestId: string; }
export interface SmsProvider { send(message: SmsMessage): Promise<void>; }
export class AliyunSmsProvider implements SmsProvider {
  constructor(private readonly config: AliyunOtpConfig, private readonly service = new AliyunSmsService(config)) {}
  async send(message: SmsMessage): Promise<void> {
    if (message.purpose !== 'sign_in' || !/^\d{6}$/.test(message.code)) throw new DomainError(400, 'SMS_INPUT_INVALID');
    await this.service.sendTemplate({
      phone: message.phone, signName: this.config.signName, templateCode: this.config.templateCode,
      templateParams: { [this.config.codeParam]: message.code }, outId: message.requestId,
    });
  }
}
export function createSmsProvider(config: Pick<AppConfig, 'smsAliyun'>): SmsProvider {
  if (!config.smsAliyun) throw new Error('INVALID_CONFIG:SMS_ALIYUN');
  return new AliyunSmsProvider(config.smsAliyun);
}
