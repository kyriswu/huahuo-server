type SmsEnv = Readonly<Record<string, string | undefined>>;

export interface AliyunSmsConnection {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
}

export interface AliyunOtpConfig extends AliyunSmsConnection {
  signName: string;
  templateCode: string;
  codeParam: string;
}

function required(env: SmsEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error('INVALID_CONFIG:' + key);
  return value;
}

export function loadAliyunSmsConnection(env: SmsEnv): AliyunSmsConnection {
  const timeout = (key: string) => {
    const value = Number(env[key] ?? 3000);
    if (!Number.isInteger(value) || value < 1000 || value > 30_000) throw new Error('INVALID_CONFIG:' + key);
    return value;
  };
  const regionId = env.SMS_ALIYUN_REGION_ID?.trim() || 'cn-hangzhou';
  if (!/^cn-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(regionId)) throw new Error('INVALID_CONFIG:SMS_ALIYUN_REGION_ID');
  return {
    accessKeyId: required(env, 'ALIYUN_RAM_ACCESS_KEY_ID'),
    accessKeySecret: required(env, 'ALIYUN_RAM_ACCESS_KEY_SECRET'),
    regionId,
    connectTimeoutMs: timeout('SMS_ALIYUN_CONNECT_TIMEOUT_MS'),
    readTimeoutMs: timeout('SMS_ALIYUN_READ_TIMEOUT_MS'),
  };
}

export function loadAliyunOtpConfig(env: SmsEnv): AliyunOtpConfig {
  const connection = loadAliyunSmsConnection(env);
  const signName = required(env, 'SMS_ALIYUN_SIGN_NAME');
  const templateCode = required(env, 'SMS_ALIYUN_TEMPLATE_CODE');
  const codeParam = env.SMS_ALIYUN_CODE_PARAM?.trim() || 'code';
  if (signName.length > 50 || /[\p{Cc}\p{Cf}]/u.test(signName)) throw new Error('INVALID_CONFIG:SMS_ALIYUN_SIGN_NAME');
  if (!/^SMS_\d+$/.test(templateCode)) throw new Error('INVALID_CONFIG:SMS_ALIYUN_TEMPLATE_CODE');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(codeParam)) throw new Error('INVALID_CONFIG:SMS_ALIYUN_CODE_PARAM');
  return { ...connection, signName, templateCode, codeParam };
}
