import { executeSmsCommand, readSmsToolInput, smsToolError, smsToolUsage } from '../tools/sms.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    process.stdout.write(smsToolUsage);
    return;
  }
  if (args.length !== 1 || !['preview', 'send', 'query'].includes(args[0]!)) {
    process.stderr.write(smsToolUsage);
    process.exitCode = 1;
    return;
  }
  const input = await readSmsToolInput(process.stdin);
  const result = await executeSmsCommand(args[0]!, input, process.env);
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(error => {
  process.stderr.write(JSON.stringify(smsToolError(error)) + '\n');
  process.exitCode = 1;
});
