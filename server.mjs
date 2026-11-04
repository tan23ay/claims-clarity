import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication } from './backend/app.mjs';
import { loadConfig, projectRoot } from './backend/config.mjs';

const envFile = join(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
const app = createApplication({ config });
app.server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT to another port.` : 'Backend failed to start.');
  app.store.close();
  process.exitCode = 1;
});
app.server.listen(config.port, config.host, () => {
  const address = app.server.address();
  console.log(`Claims Clarity frontend + API: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${address.port}`);
  console.log('Synthetic demo database ready. JEV mode: ' + (config.jevEnabled ? 'shadow' : 'disabled'));
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
