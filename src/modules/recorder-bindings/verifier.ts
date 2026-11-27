import type { RecorderVerifierConfig } from '../../config/recorder-verifier.js';
import { readJsonResponse, ServiceHttpClient } from '../../integrations/http-client.js';
import { DomainError } from '../identity/store.js';
import type { RecorderBindingVerifier } from './service.js';

/** The trusted verifier owns the hardware protocol; its decision is scoped to the account and SN. */
export class HttpRecorderBindingVerifier implements RecorderBindingVerifier {
  private readonly client: ServiceHttpClient;

  constructor(private readonly config: RecorderVerifierConfig, request?: typeof fetch) {
    this.client = new ServiceHttpClient({ fetchImpl: request });
  }

  async verify(input: Parameters<RecorderBindingVerifier['verify']>[0]) {
    try {
      return await this.client.request(this.config.url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + this.config.token, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }, { timeoutMs: 5000 }, async response => {
        if (response.status !== 200) throw new Error('VERIFIER_RESPONSE');
        const result = await readJsonResponse(response, 4096);
        if (typeof result === 'object' && result && 'verified' in result) {
          if (result.verified === false) return null;
          if (result.verified === true && 'deviceId' in result && typeof result.deviceId === 'string' &&
              'modelCode' in result && typeof result.modelCode === 'string') {
            return { deviceId: result.deviceId, modelCode: result.modelCode };
          }
        }
        throw new Error('VERIFIER_RESPONSE');
      });
    } catch {
      throw new DomainError(503, 'RECORDER_VERIFIER_UNAVAILABLE');
    }
  }
}
