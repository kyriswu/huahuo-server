import { describe, expect, it } from 'vitest';
import { loadApiServiceBaseUrl } from '../../src/config/service-addresses.js';
import { loadConfig } from '../../src/config/config.js';
import { env } from '../helpers.js';

describe('API service address for an independently deployed Admin', () => {
  it('keeps the service, public API and Admin origins independent across roles', () => {
    for (const role of ['api-server', 'admin', 'worker', 'scheduler'] as const) {
      const config = loadConfig(role, { ...env, API_SERVICE_BASE_URL: 'http://10.20.0.5:3000/',
        APP_PUBLIC_BASE_URL: 'https://api.example.test', ADMIN_PUBLIC_BASE_URL: 'https://admin.example.test' });
      expect(config.apiServiceBaseUrl).toBe('http://10.20.0.5:3000');
      expect(config.appPublicBaseUrl).toBe('https://api.example.test');
      expect(config.adminOrigin).toBe('https://admin.example.test');
    }
  });
  it('uses explicitly configured public API as the default and never invents a container/localhost address', () => {
    expect(loadApiServiceBaseUrl({ APP_PUBLIC_BASE_URL: 'https://api.example.test/' })).toBe('https://api.example.test');
    expect(loadApiServiceBaseUrl({})).toBeUndefined();
    expect(loadApiServiceBaseUrl({ API_SERVICE_BASE_URL: '' })).toBeUndefined();
    expect(loadApiServiceBaseUrl({ ADMIN_PUBLIC_BASE_URL: 'https://admin.example.test' })).toBeUndefined();
  });
  it('accepts service DNS and proxy path prefixes without selecting a container', () => {
    expect(loadApiServiceBaseUrl({ API_SERVICE_BASE_URL: 'https://api.internal.example/services/huahuo/' }))
      .toBe('https://api.internal.example/services/huahuo');
  });
  it.each(['ftp://10.20.0.5', 'http://user:secret@10.20.0.5', 'https://api.example.test/?token=secret', 'https://api.example.test/#secret', 'api.example.test:3000'])(
    'rejects malformed or secret-bearing service address without exposing it (%#)', url => {
      expect(() => loadApiServiceBaseUrl({ API_SERVICE_BASE_URL: url })).toThrow('INVALID_CONFIG:API_SERVICE_BASE_URL');
    });
});
