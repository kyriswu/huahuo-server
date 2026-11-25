import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Release tooling uses dependency-free JavaScript.
import { prepareCiNotification, sendCiNotification } from '../../scripts/release/ci-feishu-notification.mjs';

const repository = 'kyriswu/huahuo-server';
const sha = 'a69cfccb0f6a30919f516e0afdfa654b981bbac9';
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture';

function context(conclusion = 'success') {
  return {
    repository, eventName: 'workflow_run', ref: 'refs/heads/main', controlSha: 'a'.repeat(40),
    trigger: {
      path: '.github/workflows/release-smoke-check.yml', id: 17, run_attempt: 2,
      event: 'push', head_branch: 'test', head_sha: sha, head_repository: { full_name: repository },
      status: 'completed', conclusion, run_started_at: '2026-11-24T10:14:06Z', updated_at: '2026-11-24T10:16:12Z',
      head_commit: { message: '补齐动态纲要模板列表契约\n第二行' },
    },
  };
}

describe('Feishu notifications for the terminal test push CI run', () => {
  it('renders a green test-environment card with Markdown highlights and trusted text links', async () => {
    const title = '补齐动态纲要模板 <at id=all></at> [外链](https://example.com)';
    const body = [
      '## 改动', '', '### 接口和文档', '',
      '~~~text', '- 围栏里的示意代码', '## 代码内的标题', '~~~', '',
      '<!--', '- 隐藏说明', '-->',
      '- 在模板列表说明中补齐纲要场景',
      '在生成接口补充请求和响应示例。',
      '- 超过三条后的细节',
      '## 验证', '- 内部验收步骤',
    ].join('\n');
    const read = vi.fn(async () => [
      { number: 70, title: '已换版本', merge_commit_sha: 'b'.repeat(40), merged_at: '2026-11-24', base: { ref: 'test' } },
      { number: 71, title, body, merge_commit_sha: sha, merged_at: '2026-11-24', base: { ref: 'test', repo: { full_name: repository } } },
    ]);
    const card = await prepareCiNotification(context(), read);
    expect(read.mock.calls).toEqual([[`/commits/${sha}/pulls?per_page=100`]]);
    expect(card.header).toMatchObject({
      template: 'green', title: { content: '花火 Server · CI 通过' },
      subtitle: { tag: 'plain_text', content: '环境：测试 · 仅 CI 检查' },
    });
    expect(card.body.elements).toEqual(expect.arrayContaining([
      { tag: 'markdown', content: expect.stringContaining('**分支与版本** test @ a69cfcc') },
      { tag: 'markdown', content: expect.stringContaining('2026-11-24 18:14:06') },
      { tag: 'markdown', content: expect.stringContaining('2 分 6 秒') },
      { tag: 'markdown', content: expect.stringContaining('**部署状态** 本次未执行部署') },
    ]));
    const highlights = card.body.elements.find((element: { content?: string }) => element.content?.startsWith('**本次变更重点**')).content;
    expect(highlights.split('\n').filter((line: string) => line.startsWith('- '))).toEqual([
      expect.stringContaining('补齐动态纲要模板 &#60;at'),
      '- 在模板列表说明中补齐纲要场景',
      '- 在生成接口补充请求和响应示例。',
    ]);
    expect(highlights).not.toContain('<at');
    expect(highlights).not.toContain('](https://');
    expect(highlights).not.toMatch(/围栏|隐藏说明|内部验收步骤|超过三条/u);
    expect(card.body.elements.at(-1)).toEqual({ tag: 'markdown', content:
      `[查看 Actions](https://github.com/${repository}/actions/runs/17/attempts/2) · [查看 PR #71](https://github.com/${repository}/pull/71)` });
    expect(card.body.elements.some((element: { tag: string }) => element.tag === 'button')).toBe(false);
  });

  it('renders a red card with the actual failing step for this attempt', async () => {
    const read = vi.fn(async (path: string) => {
      if (path.startsWith('/commits')) throw Error('fixture unavailable');
      return { jobs: [
        { id: 30, name: 'Server CI', conclusion: 'failure', steps: [{ name: 'Require both check suites to pass', conclusion: 'failure' }] },
        { id: 31, name: 'Server code checks', conclusion: 'failure', steps: [{ name: 'Lint', conclusion: 'failure' }] },
      ] };
    });
    const card = await prepareCiNotification(context('failure'), read);
    expect(read).toHaveBeenCalledWith('/actions/runs/17/attempts/2/jobs?per_page=100');
    expect(card.header).toMatchObject({
      template: 'red', title: { content: '花火 Server · CI 失败' },
      subtitle: { content: '环境：测试 · 仅 CI 检查' },
    });
    expect(card.body.elements[0].text.content).toContain('Server code checks / Lint');
    expect(card.body.elements[1].text.content).toContain('检查未通过');
    expect(card.body.elements).toContainEqual({ tag: 'markdown', content: expect.stringContaining('**部署状态** 本次未执行部署') });
    expect(card.body.elements).toContainEqual({ tag: 'markdown', content: '**本次变更重点**\n\n- 补齐动态纲要模板列表契约' });
    expect(card.body.elements.at(-1)).toEqual({ tag: 'markdown', content:
      `[查看失败任务](https://github.com/${repository}/actions/runs/17/job/31)` });
  });

  it('retains a failure card and its run link when job details are unavailable', async () => {
    const card = await prepareCiNotification(context('failure'), async () => { throw Error('fixture unavailable'); });
    expect(card.body.elements[0].text.content).toContain('查看 Actions 日志');
    expect(card.body.elements.at(-1).content).toContain('/actions/runs/17/attempts/2');
  });

  it.each([
    { event: 'pull_request' }, { head_branch: 'main' }, { status: 'in_progress' },
    { path: '.github/workflows/other.yml' }, { run_attempt: 0 },
    { head_repository: { full_name: 'lookalike/huahuo-server' } },
  ])('rejects invalid event metadata %j before making a request', async patch => {
    const event = context();
    Object.assign(event.trigger, patch);
    const read = vi.fn();
    await expect(prepareCiNotification(event, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('skips cancelled runs', async () => {
    const read = vi.fn();
    await expect(prepareCiNotification(context('cancelled'), read)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('signs the card and requires Feishu business acceptance', async () => {
    const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(
      async () => Response.json({ code: 0 }),
    );
    const card = { schema: '2.0' };
    await expect(sendCiNotification(webhook, 'fixture-secret', card, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    const payload = JSON.parse(String(options.body));
    expect(url).toBe(webhook);
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(payload).toMatchObject({ msg_type: 'interactive', card,
      sign: createHmac('sha256', `${payload.timestamp}\nfixture-secret`).digest('base64') });
    request.mockResolvedValueOnce(Response.json({ code: 19021 }));
    await expect(sendCiNotification(webhook, '', card, request)).rejects.toThrow('FEISHU_CI_DELIVERY_REJECTED');
    await expect(sendCiNotification('https://example.com', '', card, request)).rejects.toThrow('FEISHU_CI_WEBHOOK_INVALID');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
