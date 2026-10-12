import { buildApiServer } from '../apps/api-server.js';
import { loadConfig } from '../config/config.js';
import { serve } from './runtime.js';
const config = loadConfig('api-server');
await serve(await buildApiServer({ config }), config);
