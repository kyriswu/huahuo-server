export const isLoopback = hostname => hostname === '127.0.0.1' || hostname === '[::1]';

export function getLocalPostgresTarget(connection) {
  let url;
  let database;
  try {
    url = new URL(connection?.trim());
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('LOCAL_DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !database || /[/\0]/u.test(database)
      || !url.username || url.search || url.hash) {
    throw new Error('LOCAL_DATABASE_URL_INVALID');
  }
  if (!isLoopback(url.hostname)) {
    throw new Error('LOCAL_DATABASE_REQUIRES_LOOPBACK');
  }
  // Pin the PostgreSQL default so ambient PGPORT cannot change the endpoint.
  url.port ||= '5432';
  return { url, database };
}
