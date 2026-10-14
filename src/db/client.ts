import mongoose from "mongoose";
import { env } from "../config/env.ts";
import { log } from "../lib/logger.ts";

/*
 * The MongoDB connection. Indexes are created by `npm run db:indexes`, not on start-up (see docs/DATABASE.md).
 * Inside `transaction(fn)` every query joins the transaction automatically (async local storage), so no call can
 * forget the session. MongoDB does not allow parallel operations in one transaction: no Promise.all inside fn.
 */
mongoose.set("strictQuery", true);
mongoose.set("runValidators", true);
mongoose.set("transactionAsyncLocalStorage", true);

mongoose.connection.on("error", (error) => log.error("db.connection_error", { error }));

export async function connectDb() {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DB_NAME,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false,
    autoCreate: false,
  });
}

export const disconnectDb = () => mongoose.disconnect();

/** Runs fn in a multi-document transaction. Mongoose retries it on transient errors, so keep side effects outside. */
export const transaction = <T>(fn: () => Promise<T>): Promise<T> => mongoose.connection.transaction(fn);

/** For /health: a round trip to the server. */
export const pingDb = () => mongoose.connection.db!.admin().ping();
