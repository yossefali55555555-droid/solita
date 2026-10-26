// Local development server. On Vercel, api/index.js is used instead.
import { ConfigError, getConfig } from './config/env.js';
import { connectDb } from './db/connect.js';
import { initDatabase } from './db/initDatabase.js';
import { createApp } from './app.js';

async function main() {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}\n\nSee .env.example and README.md.\n`);
      process.exit(1);
    }
    throw err;
  }

  if (config.mockMode) {
    await connectDb();
    await initDatabase();
    const { seedDemoData } = await import('../scripts/seed-demo-data.js');
    const summary = await seedDemoData();
    console.warn('\n================ MOCK MODE (DEMO DATA) ================');
    console.warn('In-memory database. Nothing is saved. Never use for real orders.');
    console.warn(`Demo admin:   ${summary.admin.phone}  /  ${summary.password}`);
    console.warn(`Demo courier: ${summary.courier.phone}  /  ${summary.password}`);
    console.warn('=======================================================\n');
  }
  if (config.sessionSecretIsEphemeral) {
    console.warn('SESSION_SECRET is not set: using a temporary development secret.');
  }

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Solita API listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
