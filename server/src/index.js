// Local development server. On Vercel, api/index.js is used instead.
import './config/loadEnv.js';
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
  } else {
    // Connect up front so a bad MONGODB_URI shows here, not only on the first login.
    try {
      await connectDb();
      console.log('Connected to MongoDB (database "solita").');
    } catch (err) {
      console.error(`\nCould not connect to MongoDB: ${err.message}`);
      console.error('Check MONGODB_URI in .env and Network Access in Atlas. The server keeps running and retries on each request.\n');
    }
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
