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
