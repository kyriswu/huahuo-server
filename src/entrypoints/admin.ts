import { buildAdminServer } from '../apps/admin.js';
import { loadConfig } from '../config/config.js';
import { serve } from './runtime.js';
const config = loadConfig('admin');
await serve(await buildAdminServer({ config }), config);
