import dns from 'node:dns';
import mongoose from 'mongoose';
import { getConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

mongoose.set('strictQuery', true);
// Never buffer commands forever when the database is unreachable: fail fast
// with a clear error instead of hanging a serverless invocation.
mongoose.set('bufferTimeoutMS', 8000);

/**
 * A single cached connection per process. On Vercel, warm invocations of the
 * same function instance reuse it; the promise is cached on globalThis so
 * concurrent requests during a cold start share one connection attempt.
 */
const cache = (globalThis.__solitaMongo ||= { promise: null, memoryServer: null });

export async function connectDb({ uri, dbName } = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (cache.promise) return cache.promise;

  const config = getConfig();
  let connectionUri = uri || config.mongodbUri;

  // Mock mode always uses its own in-memory database, even if MONGODB_URI is
  // set, so demo data can never be written to a real database.
  if (!uri && config.mockMode) {
    connectionUri = await startMockDatabase();
  }
  if (!connectionUri) {
    throw new Error('MONGODB_URI is not configured');
  }
  // Optional: some networks (often on Windows) refuse the SRV lookups that
  // mongodb+srv:// needs. MONGODB_DNS_SERVERS points Node at public resolvers.
  if (config.mongodbDnsServers.length) dns.setServers(config.mongodbDnsServers);

  cache.promise = mongoose
    .connect(connectionUri, {
      dbName: dbName || config.databaseName,
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 30000,
      autoIndex: false, // indexes are created by `npm run db:init` (and in tests/mock mode)
    })
    .then((m) => m.connection)
    .catch((err) => {
      cache.promise = null;
      if (/querySrv|ENOTFOUND _mongodb/.test(err.message)) {
        err.message +=
          ' (DNS lookup for the mongodb+srv address failed. Set MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1 in .env, ' +
          'change your DNS, or use the standard mongodb:// connection string from Atlas.)';
      }
      throw err;
    });

  return cache.promise;
}

/**
 * Development-only: start an in-memory MongoDB. The dependency is a
 * devDependency loaded dynamically, so it is never part of a production path.
 * getConfig() already refuses MOCK_MODE in production; this is a second guard.
 */
async function startMockDatabase() {
  const config = getConfig();
  if (config.isProduction) throw new Error('Mock database is not allowed in production');
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  cache.memoryServer = await MongoMemoryServer.create();
  logger.warn('MOCK MODE: using a temporary in-memory MongoDB. Data is demo-only and lost on restart.');
  return cache.memoryServer.getUri();
}

export function isUsingMockDatabase() {
  return Boolean(cache.memoryServer);
}

export async function disconnectDb() {
  cache.promise = null;
  await mongoose.disconnect();
  if (cache.memoryServer) {
    await cache.memoryServer.stop();
    cache.memoryServer = null;
  }
}
