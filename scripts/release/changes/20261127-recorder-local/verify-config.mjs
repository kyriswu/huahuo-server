const { SERVICE_ROLE: role, FUNASR_COMPUTE_PROVIDER: provider } = process.env;
const apiOnly = ['FUNASR_CALLBACK_SECRET', 'FUNASR_TASK_CREDITS'];
const workerOnly = ['FUNASR_API_TOKEN', 'FUNASR_COMPUTE_CALLBACK_ORIGIN', 'FUNASR_COMPUTE_KUBE_TOKEN_FILE',
  'FUNASR_COMPUTE_KUBE_CLIENT_CERTIFICATE_FILE', 'FUNASR_COMPUTE_KUBE_CLIENT_KEY_FILE'];
const unexpected = [
  ...(role === 'api-server' ? [] : apiOnly),
  ...(role === 'worker' ? [] : workerOnly),
];
if (unexpected.some(key => process.env[key]?.trim())
  || (role !== 'api-server' && role !== 'worker' && provider?.trim())) {
  throw new Error('FUNASR_CONFIG_WRONG_ROLE');
}

for (const [owner, urlKey, tokenKey] of [
  ['api-server', 'RECORDER_VERIFIER_URL', 'RECORDER_VERIFIER_TOKEN'],
  ['worker', 'RECORDING_OUTLINE_SERVICE_URL', 'RECORDING_OUTLINE_SERVICE_TOKEN'],
]) {
  const url = process.env[urlKey]?.trim(), token = process.env[tokenKey]?.trim();
  if ((role !== owner && (url || token)) || Boolean(url) !== Boolean(token)) {
    throw new Error('RECORDER_SERVICE_CONFIG_INVALID');
  }
}
