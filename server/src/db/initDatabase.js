import mongoose from 'mongoose';
import { allModels, User } from '../models/index.js';
import { ensureSingleAdminIndex } from './migrations/moderatorsPhase1.js';

/**
 * Create (or verify) every collection and index. Safe to run repeatedly:
 * it never drops collections, documents or indexes. Model.createIndexes()
 * only creates indexes that do not exist yet.
 *
 * Returns a report per collection.
 */
export async function initDatabase({ log = () => {} } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected');

  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const report = [];

  for (const model of allModels) {
    const name = model.collection.collectionName;
    let created = false;
    if (!existing.has(name)) {
      await model.createCollection();
      created = true;
    }
    await model.createIndexes();
    // One-admin index: checked migration step (skipped with a reason while
    // several admins exist), never part of the schema's own indexes.
    const singleAdmin = model === User ? await ensureSingleAdminIndex() : undefined;
    if (singleAdmin?.status === 'skipped') log(`WARNING users: one-admin index not built (${singleAdmin.reason})`);
    const indexes = await model.collection.indexes();
    report.push({ collection: name, created, indexes: indexes.map((i) => i.name), ...(singleAdmin ? { singleAdmin } : {}) });
    log(`${created ? 'created ' : 'verified'} ${name} (${indexes.length} indexes)`);
  }
  return report;
}
