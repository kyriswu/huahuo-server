const { APP_ENV, KB_INDEX_LAYOUT, RAG_RERANK_PROVIDER } = process.env;
if (APP_ENV !== 'test' || KB_INDEX_LAYOUT !== 'sparse-v1' || RAG_RERANK_PROVIDER !== 'disabled') {
  console.error('RELEASE_TEST_TEXTLESS_CONFIGURATION_REQUIRED');
  process.exitCode = 1;
}
