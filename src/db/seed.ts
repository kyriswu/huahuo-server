// No P01 business fixtures exist. Never manufacture accounts or commercial policy.
if (process.env.APP_ENV !== 'development' || process.env.ALLOW_DEV_SEED !== 'true') {
  throw new Error('DEV_SEED_REQUIRES_EXPLICIT_DEVELOPMENT');
}
console.log(JSON.stringify({ stage: 'P01', seeded: 0, reason: 'No business fixtures in P01' }));
