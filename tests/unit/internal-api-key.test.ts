import { describe, expect, it } from 'vitest';
import { AgentServiceKeyAuthenticator } from '../../src/modules/internal-auth/api-key.js';

const current = 'a'.repeat(43);
const previous = 'b'.repeat(43);

describe('Agent service key authentication', () => {
  it('accepts the configured Agent to Server service key only', () => {
    const auth = new AgentServiceKeyAuthenticator({ agentToServerServiceKey: current });
    expect(() => auth.verify(current)).not.toThrow();
    expect(() => auth.verify(previous)).toThrowError('INTERNAL_UNAUTHORIZED');
  });

  it('rejects missing, malformed and unknown keys', () => {
    const auth = new AgentServiceKeyAuthenticator({ agentToServerServiceKey: current });
    expect(() => auth.verify(undefined)).toThrowError('INTERNAL_UNAUTHORIZED');
    expect(() => auth.verify('wrong')).toThrowError('INTERNAL_UNAUTHORIZED');
    expect(() => auth.verify(`Bearer ${current}`)).toThrowError('INTERNAL_UNAUTHORIZED');
    expect(() => new AgentServiceKeyAuthenticator({}).verify(current)).toThrowError('INTERNAL_AUTH_NOT_CONFIGURED');
  });
});

