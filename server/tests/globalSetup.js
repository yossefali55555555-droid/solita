import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Starts one throw-away in-memory MongoDB for the whole test run. Tests never
 * read MONGODB_URI, so they can never touch a real (production) database.
 * The first run downloads a MongoDB binary (set MONGOMS_SYSTEM_BINARY to use
 * a locally installed mongod instead).
 */
let server;

export async function setup({ provide }) {
  server = await MongoMemoryServer.create();
  provide('mongoUri', server.getUri());
}

export async function teardown() {
  await server?.stop();
}
