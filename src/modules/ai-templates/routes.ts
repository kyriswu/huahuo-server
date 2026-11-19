import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';

import { ErrorSchema, failure, success } from '../../contracts/envelope.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Id, Strict } from '../identity/schemas.js';
import { DomainError } from '../identity/store.js';
import { readTrustedScope } from '../identity/trusted-scope.js';
import type { AiTemplateAgentClient } from './agent-client.js';
import { ItemKeySchema, RunRequestSchema, SceneKeySchema, type RunRequest, type SceneKey } from './model.js';
import { runData, RunTimeoutMs, type AiTemplateRuns } from './runs.js';

const runPath = '/api/v1/workspaces/:workspaceId/ai-template-runs';
const errors = { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 502: ErrorSchema, 503: ErrorSchema, 504: ErrorSchema };
const revision = Type.Integer({ minimum: 1 });
const runFields = { runId: Id, sceneKey: SceneKeySchema, itemKey: ItemKeySchema, templateVersion: revision };
const RunResult = Envelope(Type.Object({
  ...runFields,
  state: Type.Literal('succeeded'),
  result: Type.Union([
    Type.Object({ contentAssetId: Id, sourceRevision: Id, outlineMarkdown: Type.String() }, Strict),
    Type.Object({ text: Type.String() }, Strict),
  ]),
}));
const Pending = Envelope(Type.Object({ ...runFields, state: Type.Literal('running') }));
const ListResponse = Envelope(Type.Object({
  sceneKey: SceneKeySchema,
  parentKey: Type.Union([ItemKeySchema, Type.Null()]),
  title: Type.String(),
  revision,
  displayLimit: Type.Integer(),
  totalCount: Type.Integer(),
  items: Type.Array(Type.Object({
    itemKey: ItemKeySchema, kind: Type.Union([Type.Literal('group'), Type.Literal('template')]),
    title: Type.String(), description: Type.String(), icon: Type.String(), childCount: Type.Integer(),
  })),
}));

function acceptsStream(accept: string | undefined): boolean {
  return Boolean(accept?.split(',').some(value => {
    const [mediaType, ...parameters] = value.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => /^\s*q\s*=/.test(parameter))?.split('=')[1];
    return mediaType?.trim() === 'text/event-stream' && (quality === undefined || Number(quality) > 0);
  }));
}

const event = (kind: 'delta' | 'result' | 'error', data: unknown) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;

async function* withHeartbeat(frames: AsyncIterable<string>) {
  const iterator = frames[Symbol.asyncIterator]();
  try {
    let next = iterator.next();
    for (;;) {
      const timer = new AbortController();
      const heartbeat = delay(15_000, undefined, { signal: timer.signal, ref: false });
      const update = await Promise.race([next, heartbeat]).finally(() => timer.abort());
      if (!update) {
        yield ': keep-alive\n\n';
        continue;
      }
      if (update.done) return;
      yield update.value;
      next = iterator.next();
    }
  } finally { await iterator.return?.(); }
}

function sendStream(reply: FastifyReply, frames: AsyncIterable<string>) {
  return reply.type('text/event-stream; charset=utf-8').header('X-Accel-Buffering', 'no')
    .header('Cache-Control', 'no-store, no-transform').send(Readable.from(withHeartbeat(frames)));
}

function generationError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof Error && error.name === 'TimeoutError') return new DomainError(504, 'AI_TEMPLATE_TIMEOUT');
  if (error instanceof Error && error.name === 'AbortError') return new DomainError(409, 'AI_TEMPLATE_CANCELLED');
  return new DomainError(502, 'AI_TEMPLATE_GENERATION_FAILED');
}

function readRun(reply: FastifyReply, row: Parameters<typeof runData>[0], traceId: string) {
  const data = runData(row);
  if (data.state === 'running') reply.code(202);
  return success(data, traceId);
}

function scoped(req: FastifyRequest) {
  return readTrustedScope(req.headers, req.id);
}

export function registerAiTemplateRoutes(app: FastifyInstance, runs: AiTemplateRuns, agent: AiTemplateAgentClient) {
  app.get('/api/v1/ai-template-scenes/:sceneKey/items', {
    schema: {
      params: Type.Object({ sceneKey: SceneKeySchema }, Strict),
      querystring: Type.Object({ parentKey: Type.Optional(ItemKeySchema) }, Strict),
      response: { 200: ListResponse, ...errors },
    },
  }, async req => {
    const { sceneKey } = req.params as { sceneKey: SceneKey };
    const { parentKey } = req.query as { parentKey?: string };
    return success(await runs.list(sceneKey, parentKey, scoped(req)), req.id);
  });

  app.get(`${runPath}/:runId`, {
    schema: {
      params: Type.Object({ workspaceId: Id, runId: Id }, Strict),
      response: { 200: RunResult, 202: Pending, ...errors },
    },
  }, async (req, reply) => {
    const { workspaceId, runId } = req.params as { workspaceId: string; runId: string };
    return readRun(reply, await runs.get(scoped(req), workspaceId, runId), req.id);
  });

  app.get('/api/v1/workspaces/:workspaceId/content-assets/:contentAssetId/ai-outline-results', {
    schema: {
      params: Type.Object({ workspaceId: Id, contentAssetId: Id }, Strict),
      response: { 200: Envelope(Type.Object({
        contentAssetId: Id, sourceRevision: Id,
        items: Type.Array(Type.Object({ runId: Id, itemKey: ItemKeySchema, templateVersion: revision, generatedAt: Type.String() })),
      })), ...errors },
    },
  }, async req => {
    const { workspaceId, contentAssetId } = req.params as { workspaceId: string; contentAssetId: string };
    return success(await runs.outlineResults(scoped(req), workspaceId, contentAssetId), req.id);
  });

  app.post(runPath, {
    bodyLimit: 400_000,
    schema: {
      summary: '使用 AI 模板生成文本',
      description: '默认一次性返回 JSON。发送 Accept: text/event-stream 选择 SSE。'
        + '流式成功以 result 事件结束，其数据与 JSON 的成功响应一致。进行中和开流前的错误使用 JSON。',
      params: Type.Object({ workspaceId: Id }, Strict),
      body: RunRequestSchema,
      response: {
        200: { content: {
          'application/json': { schema: RunResult },
          'text/event-stream': { schema: Type.String({ description: 'SSE 事件包括 delta、result 和 error。' }) },
        } },
        202: Pending, ...errors,
      },
    },
  }, async (req, reply) => {
    const scope = scoped(req);
    const { workspaceId } = req.params as { workspaceId: string };
    const key = idempotencyKey(req, 'required')!;
    const method = req.headers['x-huahuo-auth-method'] === 'cookie' ? 'cookie' : 'bearer';
    const disconnect = new AbortController();
    let activeRunId: string | undefined;
    async function persistFailure(runId: string, error: DomainError) {
      try { await runs.fail(runId, error); }
      catch { req.log.error({ runId, errorCode: error.code }, 'Could not persist template run failure'); }
    }
    reply.raw.once('close', () => {
      if (reply.raw.writableFinished) return;
      disconnect.abort();
      if (activeRunId) void persistFailure(activeRunId, generationError(disconnect.signal.reason));
    });
    const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(RunTimeoutMs)]);
    reply.header('Vary', 'Accept');
    const stream = acceptsStream(req.headers.accept);
    const { run, input } = await runs.begin(scope, workspaceId, key, req.body as RunRequest, agent.available);
    if (!input) {
      if (run.state !== 'succeeded' || !stream) return readRun(reply, run, req.id);
      const result = success(runData(run), req.id);
      return sendStream(reply, (async function* () { yield event('result', result); })());
    }

    const inputForAgent = input;
    activeRunId = run.id;
    if (signal.aborted) {
      const error = generationError(signal.reason);
      await persistFailure(run.id, error);
      throw error;
    }

    async function* generate() {
      try {
        signal.throwIfAborted();
        for await (const output of agent.execute({ ...inputForAgent, stream }, scope, method, signal)) {
          if (output.type === 'delta') {
            yield { type: 'delta' as const, data: { runId: run.id, text: output.text } };
          } else {
            const complete = await runs.complete(scope, workspaceId, run, output.text, signal);
            activeRunId = undefined;
            yield { type: 'result' as const, data: success(runData(complete), req.id) };
            return;
          }
        }
        throw new DomainError(502, 'AI_TEMPLATE_AGENT_RESPONSE_INVALID');
      } catch (error) {
        const known = generationError(error);
        activeRunId = undefined;
        await persistFailure(run.id, known);
        throw known;
      }
    }

    if (stream) {
      return sendStream(reply, (async function* () {
        yield ': connected\n\n';
        try {
          for await (const update of generate()) yield event(update.type, update.data);
        } catch (error) {
          if (!disconnect.signal.aborted) {
            const known = generationError(error);
            yield event('error', { ...failure(known.code, 'Request could not be completed', req.id, known.statusCode === 503), runId: run.id });
          }
        }
      })());
    }

    for await (const update of generate()) {
      if (update.type === 'result') return update.data;
    }
    throw new DomainError(502, 'AI_TEMPLATE_GENERATION_FAILED');
  });
}
