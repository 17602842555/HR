import { buildApp } from "./app.mjs";

const app = await buildApp();

const shutdown = async () => {
  await app.close();
  await app.prisma.$disconnect?.();
};

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

try {
  await app.listen({
    host: app.config.host,
    port: app.config.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
