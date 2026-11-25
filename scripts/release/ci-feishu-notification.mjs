import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { githubReader, readReleaseEventContext, REPOSITORY, verifyCompletedCiTrigger } from './release-events.mjs';

const github = 'https://github.com/' + REPOSITORY;
const isPositiveId = value => Number.isSafeInteger(value) && value > 0;
const failureReasons = new Map([
  ['failure', '检查未通过，详情见任务日志'],
  ['timed_out', '任务达到运行时间上限'],
  ['startup_failure', '任务启动失败'],
]);
const chinaTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const changeHeading = /^(?:改动|变更|主要改动|主要变更|本次改动|本次变更|本次变更重点|变更内容|变更摘要|summary|what changed)[：:]?$/iu;

function singleLine(value) {
  if (typeof value !== 'string') return '';
  const line = value.split(/\r\n|[\r\n\u2028\u2029]/u, 1)[0].replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return Array.from(line).slice(0, 160).join('');
}

function changeHighlights(pr, run) {
  const title = singleLine(pr?.title) || singleLine(run.head_commit?.message);
  const points = new Set(title ? [title] : []);
  const body = typeof pr?.body === 'string' ? pr.body.slice(0, 8192) : '';
  const lines = body.replace(/<!--[\s\S]*?(?:-->|$)/gu, '').split(/\r\n|\r|\n/u);
  let sectionLevel = 0;
  let fence = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const marker = /^(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
      continue;
    }
    if (fence || !line) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading) {
      if (sectionLevel && heading[1].length <= sectionLevel) break;
      if (!sectionLevel && changeHeading.test(heading[2])) sectionLevel = heading[1].length;
      continue;
    }
    if (!sectionLevel || /^[<>]/u.test(line) || /^(?: {4}|\t)/u.test(rawLine)) continue;
    const item = singleLine(line.replace(/^(?:[-+*]|\d+[.)])\s+/u, '').replace(/`([^`]+)`/gu, '$1'));
    if (item) points.add(item);
    if (points.size >= 3) break;
  }
  return points.size ? [...points] : ['查看提交详情'];
}

function markdownLiteral(text) {
  // Feishu interprets both Markdown and its own HTML tags. Render PR text literally.
  return text.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu, character => '&#' + character.charCodeAt(0) + ';');
}

function describeTime(run) {
  const start = Date.parse(run.run_started_at);
  const end = Date.parse(run.updated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'Actions 运行时间见详情';
  const seconds = Math.floor((end - start) / 1000);
  const duration = [Math.floor(seconds / 60) + ' 分', (seconds % 60) + ' 秒'].join(' ');
  return chinaTime.format(start) + ' → ' + chinaTime.format(end) + '（' + duration + '）';
}

async function findMergedPr(run, read) {
  const prs = await read('/commits/' + run.head_sha + '/pulls?per_page=100').catch(() => null);
  if (!Array.isArray(prs)) return null;
  return prs.find(pr => isPositiveId(pr?.number) && pr.merged_at && pr.base?.ref === 'test'
    && pr.base.repo?.full_name === REPOSITORY && pr.merge_commit_sha === run.head_sha) ?? null;
}

async function findFailedJob(run, read) {
  const result = await read('/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs?per_page=100')
    .catch(() => null);
  if (!Array.isArray(result?.jobs)) return null;
  const jobs = result.jobs.filter(job => isPositiveId(job?.id) && failureReasons.has(job.conclusion));
  return jobs.find(job => job.name !== 'Server CI' && job.name !== 'Release impact report')
    ?? jobs.find(job => job.name === 'Server CI') ?? null;
}

function textLine(content) {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

export async function prepareCiNotification(context, read) {
  const run = verifyCompletedCiTrigger(context, 'test');
  if (!['success', 'failure'].includes(run.conclusion)) return null;
  if (!isPositiveId(run.run_attempt)) throw Error('RELEASE_CI_EVENT_NOT_VERIFIED');

  const passed = run.conclusion === 'success';
  const [pr, failedJob] = await Promise.all([findMergedPr(run, read), passed ? null : findFailedJob(run, read)]);
  const runUrl = github + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt;
  const jobUrl = failedJob && github + '/actions/runs/' + run.id + '/job/' + failedJob.id;
  const statusLink = jobUrl ? '[查看失败任务](' + jobUrl + ')' : '[查看 Actions](' + runUrl + ')';
  const links = [statusLink];
  if (pr) links.push('[查看 PR #' + pr.number + '](' + github + '/pull/' + pr.number + ')');

  const elements = [];
  if (!passed) {
    const step = Array.isArray(failedJob?.steps)
      ? failedJob.steps.find(entry => failureReasons.has(entry?.conclusion)) : null;
    const phase = [singleLine(failedJob?.name), singleLine(step?.name)].filter(Boolean).join(' / ');
    elements.push(textLine('失败阶段  ' + (phase || '任务详情未返回，请查看 Actions 日志')));
    if (failedJob) elements.push(textLine('失败原因  ' + failureReasons.get(failedJob.conclusion)));
  }
  const revision = run.head_sha.slice(0, 7);
  const attempt = run.run_attempt > 1 ? ' · 第 ' + run.run_attempt + ' 次运行' : '';
  const highlights = changeHighlights(pr, run).map(point => '- ' + markdownLiteral(point));
  elements.push(
    { tag: 'markdown', content: [
      '**提交** ' + revision + attempt,
      '**时间（北京时间）** ' + describeTime(run),
      '**部署状态** 本次未执行部署',
    ].join('\n\n') },
    { tag: 'markdown', content: '**本次变更重点**\n\n' + highlights.join('\n') },
    { tag: 'markdown', content: links.join(' · ') },
  );
  return {
    schema: '2.0',
    header: {
      template: passed ? 'green' : 'red',
      title: { tag: 'plain_text', content: passed ? '花火 Server · CI 通过' : '花火 Server · CI 失败' },
      subtitle: { tag: 'plain_text', content: '分支：' + run.head_branch },
    },
    body: { elements },
  };
}

// The default-branch notification runs without the application dependencies.
export async function sendCiNotification(webhook, secret, card, request = fetch) {
  const url = URL.parse(webhook);
  if (url?.origin !== 'https://open.feishu.cn' || url.href !== url.origin + url.pathname
    || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/u.test(url.pathname)) {
    throw Error('FEISHU_CI_WEBHOOK_INVALID');
  }
  const payload = { msg_type: 'interactive', card };
  if (secret) {
    payload.timestamp = String(Math.floor(Date.now() / 1000));
    payload.sign = createHmac('sha256', payload.timestamp + '\n' + secret).digest('base64');
  }

  let response;
  try {
    response = await request(url.href, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
  } catch { throw Error('FEISHU_CI_DELIVERY_UNKNOWN'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw Error(response.status >= 400 && response.status < 500 && response.status !== 408
      ? 'FEISHU_CI_DELIVERY_REJECTED' : 'FEISHU_CI_DELIVERY_UNKNOWN');
  }
  let result;
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.byteLength;
      if (length > 8192) throw Error('response too large');
      chunks.push(chunk);
    }
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw Error('FEISHU_CI_DELIVERY_UNKNOWN'); }
  if (!Number.isSafeInteger(result?.code)) throw Error('FEISHU_CI_DELIVERY_UNKNOWN');
  if (result.code !== 0) throw Error('FEISHU_CI_DELIVERY_REJECTED');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const webhook = process.env.FEISHU_CI_WEBHOOK_URL;
  try {
    if (!webhook) {
      console.log('FEISHU_CI_NOTIFICATION_SKIPPED_NO_WEBHOOK');
    } else {
      const context = await readReleaseEventContext();
      const card = await prepareCiNotification(context, githubReader(process.env.GH_TOKEN));
      if (card) {
        await sendCiNotification(webhook, process.env.FEISHU_CI_SIGNING_SECRET, card);
        console.log('FEISHU_CI_NOTIFICATION_ACCEPTED');
      }
    }
  } catch (error) {
    const codes = new Set(['RELEASE_CI_EVENT_NOT_VERIFIED', 'RELEASE_GITHUB_READ_FAILED',
      'FEISHU_CI_WEBHOOK_INVALID', 'FEISHU_CI_DELIVERY_REJECTED', 'FEISHU_CI_DELIVERY_UNKNOWN']);
    console.error(codes.has(error?.message) ? error.message : 'FEISHU_CI_NOTIFICATION_FAILED');
    process.exitCode = 1;
  }
}
