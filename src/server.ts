import { serve } from "@hono/node-server";
import { env } from "./config/env.ts";
import { connectDb, disconnectDb } from "./db/client.ts";
import { log } from "./lib/logger.ts";
import { createApp } from "./app.ts";

try {
  await connectDb();
} catch (error) {
  log.error("db.connect_failed", { error });
  process.exit(1);
}

const server = serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  log.info("server.started", { port: info.port, env: env.NODE_ENV });
});

async function shutdown(signal: string) {
  log.info("server.stopping", { signal });
  server.close();
  await disconnectDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
