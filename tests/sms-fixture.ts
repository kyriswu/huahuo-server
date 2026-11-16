import type { SmsMessage, SmsProvider } from '../src/integrations/sms.js';
import { loadConfig, type Env, type Role } from '../src/config/config.js';

export const smsEnv = {
  ALIYUN_RAM_ACCESS_KEY_ID: 'fixture-access-id', ALIYUN_RAM_ACCESS_KEY_SECRET: 'fixture-access-secret',
  SMS_ALIYUN_SIGN_NAME: '花火测试', SMS_ALIYUN_TEMPLATE_CODE: 'SMS_123456',
};

export function loadTestConfig(role: Role, env: Env = process.env) {
  return loadConfig(role, { ...env, ...smsEnv });
}

// Test-only transport: captures the generated code outside the public HTTP response.
export function recordingSms() {
  const messages = new Map<string, SmsMessage>();
  const sms: SmsProvider = { async send(message) { messages.set(message.requestId, { ...message }); } };
  const codeFor = (requestId: string) => {
    const message = messages.get(requestId);
    if (!message) throw new Error('SMS_FIXTURE_MESSAGE_REQUIRED');
    return message.code;
  };
  return { sms, messages, codeFor };
}
