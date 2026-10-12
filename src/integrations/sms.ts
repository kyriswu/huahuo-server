import { DomainError } from '../modules/identity/store.js';
export interface SmsMessage { phone: string; code: string; purpose: 'login'; requestId: string; }
export interface SmsProvider { readonly mode: 'mock' | 'live' | 'disabled'; send(message: SmsMessage): Promise<void>; }
export class MockSmsProvider implements SmsProvider {
  readonly mode = 'mock';
  async send(_message: SmsMessage) { void _message; /* Explicit local simulation: no network or success claim about SMS delivery. */ }
}
export class DisabledSmsProvider implements SmsProvider {
  readonly mode = 'disabled';
  async send(_message: SmsMessage): Promise<void> { void _message; throw new DomainError(503,'SMS_NOT_CONFIGURED'); }
}
// A selected vendor adapter supplies this transport after its protocol is verified.
// No generic arbitrary HTTP endpoint is accepted from API requests.
export class LiveSmsProvider implements SmsProvider {
  readonly mode = 'live';
  constructor(private transport: (message: SmsMessage) => Promise<{accepted: boolean}>) {}
  async send(message: SmsMessage) { if (!(await this.transport(message)).accepted) throw new DomainError(503,'SMS_PROVIDER_FAILED'); }
}
