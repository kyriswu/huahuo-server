try {
  const response = await fetch(process.env.HEALTHCHECK_URL ?? 'http://127.0.0.1:3000/health/ready', { signal: AbortSignal.timeout(7000) });
  if (!response.ok || (await response.json()).success !== true) process.exitCode = 1;
} catch { process.exitCode = 1; }
