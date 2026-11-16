import { describe, expect, it } from 'vitest';
// @ts-expect-error reviewed release tooling uses portable JavaScript
import { verifyIngressConfiguration } from '../../scripts/release/changes/20261116-gateway-qwen37/verify-config.mjs';

const candidate = {
  SERVICE_ROLE: 'api-server', APP_ENV: 'test', HTTP_TRUST_PROXY_HOPS: '1',
  HUAHUO_AGENT_PUBLIC_PATH: '/agent', HUAHUO_STUDIO_AUTH_ENABLED: 'true',
  APP_PUBLIC_BASE_URL: 'https://test-api.chuda.cc', HUAHUO_STUDIO_ORIGIN: 'https://test-api.chuda.cc',
};

describe('ingress release configuration, no network calls', () => {
  it('accepts the coordinated test candidate', () => {
    expect(() => verifyIngressConfiguration(candidate)).not.toThrow();
  });
  it.each([
    { APP_ENV: 'development' },
    { HTTP_TRUST_PROXY_HOPS: '0' },
    { HTTP_TRUST_PROXY_HOPS: '2' },
    { HUAHUO_AGENT_PUBLIC_PATH: '/other' },
    { HUAHUO_STUDIO_AUTH_ENABLED: undefined },
    { HUAHUO_STUDIO_AUTH_ENABLED: 'TRUE' },
    { HUAHUO_STUDIO_AUTH_ENABLED: 'false' },
    { APP_PUBLIC_BASE_URL: 'http://localhost:3000' },
    { HUAHUO_STUDIO_ORIGIN: 'https://test-agent.chuda.cc' },
    { HUAHUO_STUDIO_ORIGIN: 'https://test-api.chuda.cc/agent' },
  ])('rejects an individually valid but mismatched ingress setting (%j)', patch => {
    expect(() => verifyIngressConfiguration({ ...candidate, ...patch })).toThrow();
  });
  it('requires production Studio to be disabled', () => {
    expect(() => verifyIngressConfiguration({ ...candidate, APP_ENV: 'production' })).toThrow('INGRESS_PRODUCTION_STUDIO_FORBIDDEN');
    expect(() => verifyIngressConfiguration({ ...candidate, APP_ENV: 'production', HUAHUO_STUDIO_AUTH_ENABLED: 'false' })).not.toThrow();
  });
  it.each(['admin', 'worker', 'scheduler', 'migrate'])('does not require public ingress settings for %s', role => {
    expect(() => verifyIngressConfiguration({ SERVICE_ROLE: role })).not.toThrow();
  });
});
