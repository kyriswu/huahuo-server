import { readReleasePlan, ReleasePlanError, validateReleasePlan } from '../release/plan.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root' || !args[1])) throw new ReleasePlanError('RELEASE_PLAN_INVALID');
  const root = args[1] ?? process.cwd();
  const plan = await readReleasePlan(root);
  // CI verifies the committed candidate. Never silently ignore local edits or
  // untracked release files when developers run this same command locally.
  const state = await promisify(execFile)('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (state.stdout.length) throw new ReleasePlanError('RELEASE_PLAN_WORKTREE_DIRTY');
  const summary = await validateReleasePlan(plan, root);
  console.log(JSON.stringify({ status: 'passed', ...summary }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error instanceof ReleasePlanError ? error.code : 'RELEASE_PLAN_INVALID' }));
  process.exitCode = 1;
}
