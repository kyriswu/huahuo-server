try {
  const response = await fetch(new URL('/health', process.env.HUAHUO_AGENT_BASE_URL), {
    redirect: 'error', signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok || (await response.json()).success !== true) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
