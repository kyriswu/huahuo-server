import { DomainError } from '../modules/identity/store.js';
import { maskedPhone } from '../modules/identity/crypto.js';
import type { AppConfig } from '../config/config.js';
import type { AliyunOtpConfig, FeishuOtpConfig } from '../config/sms.js';
import { AliyunSmsService } from './aliyun-sms.js';
import { FeishuWebhook } from './feishu-webhook.js';
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
export class FeishuSmsProvider implements SmsProvider {
  constructor(private readonly config: FeishuOtpConfig,
    private readonly bot = new FeishuWebhook(config.webhookUrl, config.signingSecret)) {}

  async send(message: SmsMessage): Promise<void> {
    if (message.purpose !== 'sign_in' || !/^\d{6}$/.test(message.code)) throw new DomainError(400, 'SMS_INPUT_INVALID');
    await this.bot.send({ msg_type: 'text', content: { text: [
      '【花火测试验证码】', `环境：${this.config.environment}`, `手机号：${maskedPhone(message.phone)}`,
      `验证码：${message.code}`, '有效期：5 分钟',
    ].join('\n') } });
  }
}

export function createSmsProvider(config: Pick<AppConfig, 'smsAliyun' | 'smsFeishu'>): SmsProvider {
  if (config.smsFeishu) return new FeishuSmsProvider(config.smsFeishu);
  if (!config.smsAliyun) throw new Error('INVALID_CONFIG:SMS_ALIYUN');
  return new AliyunSmsProvider(config.smsAliyun);
}
