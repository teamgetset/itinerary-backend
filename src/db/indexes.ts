import { ALL_MODELS, REFERENCES } from "./models.ts";

/*
 * Database structure tooling: the MongoDB counterpart of the PostgreSQL migrations' three states.
 *   Created  - the indexes are defined in src/db/models.ts
 *   Applied  - the collections and indexes exist in the database (`npm run db:indexes`)
 *   Verified - the live indexes match the models and no reference dangles (`npm run db:verify`)
 * Nothing here ever drops a collection or an index: indexes the models no longer define are only reported.
 */

const NAMESPACE_EXISTS = 48;

/** Creates every collection and its indexes when missing. Safe to run again. */
export async function ensureIndexes() {
  for (const model of ALL_MODELS) {
    await model.createCollection().catch((error: { code?: number }) => {
      if (error.code !== NAMESPACE_EXISTS) throw error;
    });
    await model.createIndexes();
  }
}

export interface CollectionStatus {
  collection: string;
  exists: boolean;
  /** Index definitions in the model (the _id index is implicit and not counted). */
  defined: number;
  /** Defined in the model but missing from the database. */
  missing: string[];
  /** In the database but not defined by the model (left alone, reported for review). */
  unmanaged: string[];
}

export async function indexStatus(): Promise<CollectionStatus[]> {
  const result: CollectionStatus[] = [];
  for (const model of ALL_MODELS) {
    const name = model.collection.collectionName;
    const exists = (await model.db.db!.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
    const defined = model.schema.indexes();
    if (!exists) {
      result.push({ collection: name, exists, defined: defined.length, missing: defined.map(([fields]) => JSON.stringify(fields)), unmanaged: [] });
      continue;
    }
    const diff = await model.diffIndexes();
    result.push({
      collection: name,
      exists,
      defined: defined.length,
      missing: diff.toCreate.map((spec) => JSON.stringify(spec)),
      unmanaged: diff.toDrop,
    });
  }
  return result;
}

export interface DanglingReference {
  from: string;
  path: string;
  to: string;
  missing: string[];
}

/** Every reference value that points at a document that does not exist (what foreign keys used to prevent). */
export async function danglingReferences(): Promise<DanglingReference[]> {
  const problems: DanglingReference[] = [];
  for (const { from, path, to } of REFERENCES) {
    const values = ((await from.distinct(path)) as unknown[]).filter((value): value is string => typeof value === "string");
    if (!values.length) continue;
    const found = new Set((await to.find({ _id: { $in: values } }, { _id: 1 }).lean<{ _id: string }[]>()).map((row) => row._id));
    const missing = values.filter((value) => !found.has(value));
    if (missing.length) problems.push({ from: from.collection.collectionName, path, to: to.collection.collectionName, missing });
  }
  return problems;
}
