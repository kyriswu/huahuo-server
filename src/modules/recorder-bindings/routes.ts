import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ErrorSchema, success } from '../../contracts/envelope.js';
import { idempotencyKey } from '../identity/routes.js';
import { Envelope, Id, Strict, Text } from '../identity/schemas.js';
import { readTrustedScope } from '../identity/trusted-scope.js';
import type { RecorderBindingService } from './service.js';

const Mode = Type.Union([Type.Literal('auto'), Type.Literal('manual')]);
const DeviceId = Text(128);
const Timestamp = Type.String({ format: 'date-time' });
const Params = Type.Object({ bindingId: Id }, Strict);
const Empty = Type.Object({}, Strict);
const BindBody = Type.Object({
  deviceId: DeviceId,
  transferMode: Type.Optional(Mode),
  proof: Type.Optional(Text(8192)),
}, Strict);
const SettingsBody = Type.Object({
  displayName: Type.Optional(Text(120)),
  transferMode: Type.Optional(Mode),
  generationMode: Type.Optional(Mode),
  transcriptionLanguage: Type.Optional(Type.Literal('auto')),
}, { ...Strict, minProperties: 1 });
const Binding = Type.Object({
  bindingId: Id, deviceId: DeviceId, modelCode: Text(128), displayName: Type.Union([Type.String(), Type.Null()]),
  transferMode: Mode, generationMode: Mode, transcriptionLanguage: Type.String(), boundAt: Timestamp, updatedAt: Timestamp,
}, Strict);
const errors = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 503: ErrorSchema };
const bindingResponse = { 200: Envelope(Binding), ...errors };
const scope = (request: FastifyRequest) => readTrustedScope(request.headers, request.id);

export function registerRecorderBindingRoutes(app: FastifyInstance, service: RecorderBindingService) {
  const listPath = '/api/v1/recorder-bindings';
  const detailPath = listPath + '/:bindingId';
  app.get<{Querystring: {deviceId?: string}}>(listPath, {
    schema: { summary: '查询当前账号已绑定的录音卡', querystring: Type.Object({deviceId: Type.Optional(DeviceId)}, Strict),
      response: { 200: Envelope(Type.Object({items: Type.Array(Binding)}, Strict)), ...errors } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return success(await service.list(scope(request), request.query.deviceId), request.id);
  });
  app.post<{Body: Static<typeof BindBody>}>(listPath, {
    schema: { summary: '绑定录音卡或获取本人已有的绑定', body: BindBody, querystring: Empty, response: bindingResponse },
  }, async request => success(await service.bind(scope(request), request.body, idempotencyKey(request, 'required')!), request.id));
  app.get<{Params: Static<typeof Params>}>(detailPath, {
    schema: { summary: '读取录音卡绑定及设置', params: Params, querystring: Empty, response: bindingResponse },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return success(await service.detail(scope(request), request.params.bindingId), request.id);
  });
  app.patch<{Params: Static<typeof Params>; Body: Static<typeof SettingsBody>}>(detailPath, {
    schema: { summary: '更新当前账号的录音卡名称及设置', params: Params, body: SettingsBody, querystring: Empty, response: bindingResponse },
  }, async request => success(await service.update(scope(request), request.params.bindingId, request.body, idempotencyKey(request, 'required')!), request.id));
  app.delete<{Params: Static<typeof Params>}>(detailPath, {
    schema: { summary: '结束当前账号的录音卡绑定', params: Params, querystring: Empty,
      response: { 200: Envelope(Type.Object({bindingId: Id, unboundAt: Timestamp}, Strict)), ...errors } },
  }, async request => success(await service.unbind(scope(request), request.params.bindingId, idempotencyKey(request, 'required')!), request.id));
}
