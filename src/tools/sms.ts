import { loadAliyunSmsConnection } from '../config/sms.js';
import { AliyunSmsService, SmsProviderError, prepareSmsDeliveryQuery, prepareTemplateSms } from '../integrations/aliyun-sms.js';
import { maskedPhone } from '../modules/identity/crypto.js';
import { DomainError } from '../modules/identity/store.js';

export const smsToolUsage = 'Usage: pnpm sms <preview|send|query> < request.json\n'
  + 'preview: validate one template SMS locally; send: submit it once through Aliyun; query: look up its BizId.\n'
  + 'Input and template variables are read from stdin; credentials come from ALIYUN_RAM_ACCESS_KEY_ID/SECRET.\n';

export async function readSmsToolInput(stream: AsyncIterable<string | Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 8192) throw new DomainError(400, 'SMS_INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new DomainError(400, 'SMS_INPUT_INVALID_JSON'); }
}

export async function executeSmsCommand(
  command: string,
  input: unknown,
  env: Readonly<Record<string, string | undefined>>,
  createService = (connection: ReturnType<typeof loadAliyunSmsConnection>) => new AliyunSmsService(connection),
) {
  if (command === 'preview') {
    const message = prepareTemplateSms(input);
    return { status: 'preview', phoneMasked: maskedPhone(message.phone), signName: message.signName,
      templateCode: message.templateCode, templateParamNames: Object.keys(message.templateParams), outId: message.outId };
  }
  if (command === 'send') {
    const message = prepareTemplateSms(input);
    return createService(loadAliyunSmsConnection(env)).sendTemplate(message);
  }
  if (command === 'query') {
    const query = prepareSmsDeliveryQuery(input);
    return createService(loadAliyunSmsConnection(env)).queryDelivery(query);
  }
  throw new DomainError(400, 'SMS_TOOL_USAGE');
}

export function smsToolError(error: unknown) {
  if (error instanceof SmsProviderError) return { code: error.message, outcome: error.outcome,
    providerCode: error.providerCode, providerRequestId: error.providerRequestId };
  if (error instanceof DomainError) return { code: error.code };
  if (error instanceof Error && /^INVALID_CONFIG:[A-Z_]+$/.test(error.message)) return { code: error.message };
  return { code: 'SMS_TOOL_FAILED' };
}
