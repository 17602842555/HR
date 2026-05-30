import { createRequire } from "node:module";

const globalForPrisma = globalThis;
const require = createRequire(import.meta.url);

function getPrismaClient() {
  if (globalForPrisma.__deepOaPrisma) return globalForPrisma.__deepOaPrisma;

  const { PrismaClient } = require("@prisma/client");
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"]
  });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.__deepOaPrisma = client;
  }

  return client;
}

export const prisma = new Proxy({}, {
  get(_target, property) {
    return getPrismaClient()[property];
  }
});
