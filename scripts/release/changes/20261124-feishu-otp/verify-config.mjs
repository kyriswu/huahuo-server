const { SERVICE_ROLE: role, APP_ENV: environment, SMS_FEISHU_WEBHOOK_URL: webhook } = process.env;
if (role === 'api-server') {
  const url = URL.parse(webhook ?? '');
  if (environment !== 'test' || url?.origin !== 'https://open.feishu.cn'
      || url.href !== url.origin + url.pathname || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('FEISHU_TEST_OTP_CONFIG_INVALID');
  }
} else if (webhook) {
  throw new Error('FEISHU_TEST_OTP_WRONG_ROLE');
}
