import { constantEqual } from '../identity/crypto.js';
import { DomainError } from '../identity/store.js';
import type { AppConfig } from '../../config/config.js';

export class AgentServiceKeyAuthenticator {
  constructor(private readonly config: Pick<AppConfig, 'agentToServerServiceKey'>) {}

  verify(serviceKey: string | undefined): void {
    const configured = this.config.agentToServerServiceKey;
    if (!configured) throw new DomainError(503, 'INTERNAL_AUTH_NOT_CONFIGURED');
    if (!serviceKey || serviceKey.length !== configured.length || !constantEqual(serviceKey, configured)) {
      throw new DomainError(401, 'INTERNAL_UNAUTHORIZED');
    }
  }
}

