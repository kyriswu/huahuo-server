export interface AdminIdentity {
  username: string;
  role: 'operator' | 'superadmin';
}

export interface AdminSession {
  admin: AdminIdentity;
  csrfToken: string;
}

export interface Credentials {
  username: string;
  password: string;
}

type Envelope<T> = { success: true; data: T } | { success: false; error: { code: string } };

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(code ?? `ADMIN_HTTP_${status}`);
  }
}

async function request<T>(path: 'me' | 'login' | 'logout', options?: RequestInit): Promise<T> {
  const response = await fetch(`/admin/api/v1/${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  const result = await response.json().catch(() => null) as Envelope<T> | null;
  if (response.ok && result?.success === true) return result.data;
  throw new AdminApiError(response.status, result?.success === false ? result.error.code : undefined);
}

export function getSession(signal: AbortSignal) {
  return request<AdminSession>('me', { signal });
}

export function login(credentials: Credentials) {
  return request<AdminSession>('login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
}

export function logout(csrfToken: string) {
  return request<{ revoked: boolean }>('logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
  });
}
