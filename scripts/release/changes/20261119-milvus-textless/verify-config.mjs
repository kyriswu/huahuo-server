const { APP_ENV, SERVICE_ROLE, KB_INDEX_LAYOUT, RAG_RERANK_PROVIDER } = process.env;

// The migrate role has its own environment and uses only PostgreSQL.
const invalidSearchSettings = SERVICE_ROLE !== 'migrate'
  && (KB_INDEX_LAYOUT !== 'sparse-v1' || RAG_RERANK_PROVIDER !== 'disabled');
if (APP_ENV !== 'test' || invalidSearchSettings) {
  console.error('RELEASE_TEST_TEXTLESS_CONFIGURATION_REQUIRED');
  process.exitCode = 1;
}
