import mongoose from 'mongoose';
import { allModels } from '../models/index.js';

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
    const indexes = await model.collection.indexes();
    report.push({ collection: name, created, indexes: indexes.map((i) => i.name) });
    log(`${created ? 'created ' : 'verified'} ${name} (${indexes.length} indexes)`);
  }
  return report;
}
