import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';

// Test configuration. MONGODB_URI is removed so nothing can reach a real database.
process.env.NODE_ENV = 'test';
delete process.env.MONGODB_URI;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
process.env.MOCK_MODE = 'false';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-1234567890';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.EASYORDERS_WEBHOOK_SECRET = 'test-webhook-secret';
delete process.env.EASYORDERS_STATUS_WEBHOOK_SECRET;
delete process.env.EASYORDERS_API_KEY;
process.env.CRON_SECRET = 'test-cron-secret';

const { resetConfig } = await import('../src/config/env.js');
const { connectDb, disconnectDb } = await import('../src/db/connect.js');
const { initDatabase } = await import('../src/db/initDatabase.js');
const { setFetchImplementation } = await import('../src/integrations/easyorders/client.js');

beforeAll(async () => {
  resetConfig();
  const uri = inject('mongoUri');
  if (!/127\.0\.0\.1|localhost/.test(uri)) throw new Error('Refusing to run tests against a non-local database');
  await connectDb({ uri, dbName: `solita_test_${crypto.randomBytes(6).toString('hex')}` });
  await initDatabase();
});

afterEach(async () => {
  // Clear data with the native driver (bypasses the append-only guard on OrderEvent).
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  setFetchImplementation(null);
  delete process.env.EASYORDERS_API_KEY;
  resetConfig();
});

afterAll(async () => {
  await mongoose.connection.db?.dropDatabase();
  await disconnectDb();
});
