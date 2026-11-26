import type { FastifyInstance, FastifyRequest } from 'fastify';
import { funAsrCallbackBodyLimit } from '../../config/funasr.js';
import { FunAsrError, verifyFunAsrCallback } from '../../integrations/funasr/client.js';
import { DomainError } from '../identity/store.js';
import type { RuntimeSettings } from '../runtime-settings/service.js';
import type { FunAsrStore } from './store.js';

function headers(request: FastifyRequest) {
  const read = (key: string) => typeof request.headers[key] === 'string' ? request.headers[key] : undefined;
  return { eventId: read('x-funasr-event-id'), timestamp: read('x-funasr-timestamp'), signature: read('x-funasr-signature') };
}

export function registerFunAsrCallbacks(app: FastifyInstance, store: FunAsrStore, secret: string, settings: RuntimeSettings) {
  void app.register(async scope => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post<{ Params: { submissionId: string }; Body: Buffer }>('/funasr/callbacks/:submissionId', {
      bodyLimit: funAsrCallbackBodyLimit,
      config: { internalApi: { auth: 'signed-provider', authorize: async req => {
        const { submissionId } = req.params as { submissionId: string };
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(submissionId)) {
          throw new DomainError(404, 'FUNASR_CALLBACK_NOT_FOUND');
        }
        const { eventId, timestamp, signature } = headers(req);
        if (!/^evt_[a-f0-9]{32}$/u.test(eventId ?? '') || !/^\d{1,12}$/u.test(timestamp ?? '')
          || !/^v1=[a-f0-9]{64}$/u.test(signature ?? '')) throw new DomainError(401, 'FUNASR_CALLBACK_UNAUTHORIZED');
      } } },
    }, async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new DomainError(400, 'FUNASR_CALLBACK_BODY_INVALID');
      let receipt;
      try { receipt = verifyFunAsrCallback(headers(req), req.body, secret); }
      catch (error) {
        if (error instanceof FunAsrError) throw new DomainError(error.status ?? 400, error.code);
        throw error;
      }
      await settings.run(() => store.receive(req.params.submissionId, receipt));
      return reply.code(204).send();
    });
  });
}
