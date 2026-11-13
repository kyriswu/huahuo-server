import { loadDocumentParserMachineConfig, createDocumentParserMachine, ParserMachineError } from '../lib/document-parser-machine/index.js';
import { AliyunEcsPower, EcsPowerError } from '../integrations/ecs-power.js';

const usage = 'Usage: pnpm document-parser:machine status|configure-idle\n';
async function main() {
  const command = process.argv[2] ?? 'status';
  if (process.argv.length > 3 || !['status', 'configure-idle'].includes(command)) {
    process.stderr.write(usage); process.exitCode = 1; return;
  }
  const config = loadDocumentParserMachineConfig();
  if (!config.enabled) { process.stdout.write(JSON.stringify({ mode: 'disabled' }) + '\n'); return; }
  const redisUrl = process.env.REDIS_QUEUE_URL;
  if (!redisUrl || !['redis:', 'rediss:'].includes(new URL(redisUrl).protocol)) throw new ParserMachineError('DOCUMENT_PARSER_REDIS_URL_REQUIRED');
  const module = createDocumentParserMachine(config, redisUrl, process.env.REDIS_KEY_PREFIX ?? 'huahuo-dev')!;
  try {
    await module.connect();
    if (command === 'configure-idle') await module.machine.state.configureWhenIdle();
    const redis = await module.machine.state.status();
    // This tool performs no cloud mutation. Only the request wrapper and scheduler do so.
    const instance = config.mode === 'ecs' ? await new AliyunEcsPower(config).describe() : undefined;
    process.stdout.write(JSON.stringify({ mode: config.mode, redis: redis ?? null, ...(instance ? { instance } : {}) }) + '\n');
  } finally { await module.close(); }
}
main().catch(error => {
  process.stderr.write(JSON.stringify(error instanceof ParserMachineError || error instanceof EcsPowerError
    ? { code: error.code, ...(error instanceof EcsPowerError ? { providerCode: error.providerCode, requestId: error.requestId } : {}) }
    : { code: 'DOCUMENT_PARSER_MACHINE_TOOL_FAILED' }) + '\n');
  process.exitCode = 1;
});
