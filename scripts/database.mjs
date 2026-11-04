import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../backend/database.mjs';
import { loadConfig, projectRoot } from '../backend/config.mjs';

if (existsSync(join(projectRoot, '.env'))) process.loadEnvFile(join(projectRoot, '.env'));
const store = new Store(loadConfig());
console.log(`Migrations applied. ${store.claims().total} synthetic claims persisted.`);
console.log(JSON.stringify(store.verifyAudit()));
store.close();
