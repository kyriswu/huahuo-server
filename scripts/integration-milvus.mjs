import { MilvusClient } from '@zilliz/milvus2-sdk-node';

export class TestMilvusError extends Error {
  constructor(code) { super(code); this.name = 'TestMilvusError'; }
}

function checked(response, code) {
  const status = response?.status ?? response;
  if (status?.error_code !== undefined ? status.error_code !== 'Success' : status?.code !== 0) throw new TestMilvusError(code);
  return response;
}

export function cloudMilvusConfig(env) {
  if (['MILVUS_ADDRESS', 'MILVUS_USERNAME', 'MILVUS_PASSWORD'].some(key => !env[key]?.trim())) throw new TestMilvusError('TEST_CLOUD_MILVUS_CONFIG_REQUIRED');
  if (env.MILVUS_TLS !== undefined && !['true', 'false'].includes(env.MILVUS_TLS)) throw new TestMilvusError('TEST_CLOUD_MILVUS_TLS_INVALID');
  const proxy = env.TEST_MILVUS_GRPC_PROXY?.trim();
  if (proxy) {
    let url;
    try { url = new URL(proxy); } catch { throw new TestMilvusError('TEST_CLOUD_MILVUS_PROXY_INVALID'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new TestMilvusError('TEST_CLOUD_MILVUS_PROXY_INVALID');
  }
  // Ignore the business database, collections, inherited proxy and unrelated
  // model/OSS/SQL credentials. Only the explicit cloud mode calls this function.
  return {
    address: env.MILVUS_ADDRESS.trim(), username: env.MILVUS_USERNAME.trim(), password: env.MILVUS_PASSWORD,
    ssl: env.MILVUS_TLS !== 'false', ...(proxy ? { proxy } : {}),
  };
}

export class IsolatedCloudMilvus {
  constructor(config, runId, clientFactory = options => new MilvusClient(options)) {
    if (!/^[a-f0-9]{32}$/u.test(runId)) throw new TestMilvusError('TEST_CLOUD_MILVUS_RUN_ID_INVALID');
    this.database = `huahuo_test_${runId}`;
    this.collections = Object.freeze({ note: `huahuo_test_note_${runId}`, document: `huahuo_test_document_${runId}` });
    this.config = config;
    this.clientFactory = clientFactory;
    this.clients = [];
    this.created = false;
  }

  client(database) {
    const client = this.clientFactory({
      address: this.config.address, username: this.config.username, password: this.config.password, ssl: this.config.ssl,
      database, timeout: 15_000, maxRetries: 0, logLevel: 'error', pool: { min: 0, max: 1 },
      channelOptions: { 'grpc.enable_http_proxy': this.config.proxy ? 1 : 0 },
    });
    void client.connectPromise.catch(() => undefined);
    this.clients.push(client);
    return client;
  }

  async create() {
    this.admin = this.client('default');
    try {
      await this.admin.connectPromise;
      const existing = checked(await this.admin.listDatabases(), 'TEST_CLOUD_MILVUS_LIST_FAILED');
      if (existing.db_names.includes(this.database)) throw new TestMilvusError('TEST_CLOUD_MILVUS_DATABASE_EXISTS');
      checked(await this.admin.createDatabase({ db_name: this.database }), 'TEST_CLOUD_MILVUS_CREATE_FAILED');
      this.created = true;
      const description = checked(await this.admin.describeDatabase({ db_name: this.database }), 'TEST_CLOUD_MILVUS_DESCRIBE_FAILED');
      if (description.db_name !== this.database || !description.dbID || !description.created_timestamp) throw new TestMilvusError('TEST_CLOUD_MILVUS_IDENTITY_REQUIRED');
      this.identity = { id: String(description.dbID), timestamp: String(description.created_timestamp) };
      this.scoped = this.client(this.database);
      await this.scoped.connectPromise;
    } catch (error) {
      if (error instanceof TestMilvusError) throw error;
      throw new TestMilvusError('TEST_CLOUD_MILVUS_UNAVAILABLE');
    }
    return {
      TEST_MILVUS_MODE: 'cloud', TEST_MILVUS_ADDRESS: this.config.address,
      TEST_MILVUS_USERNAME: this.config.username, TEST_MILVUS_PASSWORD: this.config.password,
      TEST_MILVUS_TLS: String(this.config.ssl), TEST_MILVUS_DATABASE: this.database,
      TEST_MILVUS_NOTE_COLLECTION: this.collections.note, TEST_MILVUS_DOCUMENT_COLLECTION: this.collections.document,
      ...(this.config.proxy ? { grpc_proxy: this.config.proxy } : {}),
    };
  }

  async cleanup() {
    try {
      if (!this.created) return;
      // Bind cleanup to the new database's server-assigned identity. Never drop
      // an existing database, a replacement, or unexpected collections.
      const description = checked(await this.admin.describeDatabase({ db_name: this.database }), 'TEST_CLOUD_MILVUS_DESCRIBE_FAILED');
      if (!this.identity || description.db_name !== this.database || String(description.dbID) !== this.identity.id || String(description.created_timestamp) !== this.identity.timestamp) throw new TestMilvusError('TEST_CLOUD_MILVUS_OWNERSHIP_MISMATCH');
      this.scoped ??= this.client(this.database);
      await this.scoped.connectPromise;
      const response = checked(await this.scoped.showCollections({ db_name: this.database }), 'TEST_CLOUD_MILVUS_COLLECTION_LIST_FAILED');
      const names = response.data?.map(collection => collection.name);
      if (!Array.isArray(names) || names.some(name => !Object.values(this.collections).includes(name))) throw new TestMilvusError('TEST_CLOUD_MILVUS_UNEXPECTED_COLLECTION');
      for (const name of names) checked(await this.scoped.dropCollection({ db_name: this.database, collection_name: name }), 'TEST_CLOUD_MILVUS_COLLECTION_CLEANUP_FAILED');
      checked(await this.admin.dropDatabase({ db_name: this.database }), 'TEST_CLOUD_MILVUS_DATABASE_CLEANUP_FAILED');
      const remaining = checked(await this.admin.listDatabases(), 'TEST_CLOUD_MILVUS_LIST_FAILED');
      if (remaining.db_names.includes(this.database)) throw new TestMilvusError('TEST_CLOUD_MILVUS_DATABASE_CLEANUP_FAILED');
      this.created = false;
    } finally {
      await Promise.all(this.clients.map(client => client.closeConnection()));
    }
  }
}
