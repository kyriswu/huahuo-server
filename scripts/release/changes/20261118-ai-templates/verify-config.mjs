if (process.env.SERVICE_ROLE === 'api-server' && process.env.APP_ENV === 'test'
    && process.env.HUAHUO_AGENT_BASE_URL?.trim() !== 'http://agent:4111') {
  process.exitCode = 1;
}
