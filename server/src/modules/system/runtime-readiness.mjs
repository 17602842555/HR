import { checkAppendOnlyDatabaseTriggers } from "./database-integrity.mjs";
import { checkPrismaMigrationReadiness } from "./migration-readiness.mjs";

export async function checkFileStorageWritable(appOrConfig) {
  if (appOrConfig?.fileStorage?.probe) {
    await appOrConfig.fileStorage.probe();
    return;
  }
  throw new Error("file storage adapter is unavailable");
}

export async function readinessPayload(app, request) {
  const status = {
    database: "ok",
    databaseIntegrity: "ok",
    databaseMigrations: "ok",
    fileStorage: "ok",
    ok: true,
    service: "deep-oa-api"
  };
  let databaseReady = true;

  try {
    await app.prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    status.database = "unavailable";
    status.databaseIntegrity = "unavailable";
    status.databaseMigrations = "unavailable";
    status.ok = false;
    databaseReady = false;
    request.log.error({ error }, "database readiness check failed");
  }

  if (databaseReady) {
    try {
      const migrations = await checkPrismaMigrationReadiness(app.prisma);
      if (!migrations.ok) {
        status.databaseMigrations = "unavailable";
        status.ok = false;
        request.log.error({
          appliedCount: migrations.appliedCount,
          expectedCount: migrations.expectedCount,
          latestApplied: migrations.latestApplied,
          latestExpected: migrations.latestExpected,
          missing: migrations.missing,
          rolledBack: migrations.rolledBack
        }, "database migration readiness check failed");
      }
    } catch (error) {
      status.databaseMigrations = "unavailable";
      status.ok = false;
      request.log.error({ error }, "database migration readiness check failed");
    }

    try {
      const integrity = await checkAppendOnlyDatabaseTriggers(app.prisma);
      if (!integrity.ok) {
        status.databaseIntegrity = "unavailable";
        status.ok = false;
        request.log.error({
          found: integrity.found,
          missing: integrity.missing,
          required: integrity.required
        }, "database append-only trigger readiness check failed");
      }
    } catch (error) {
      status.databaseIntegrity = "unavailable";
      status.ok = false;
      request.log.error({ error }, "database append-only trigger readiness check failed");
    }
  }

  try {
    await checkFileStorageWritable(app);
  } catch (error) {
    status.fileStorage = "unavailable";
    status.ok = false;
    request.log.error({
      error,
      fileStorageDriver: app.config.fileStorageDriver,
      fileStorageDir: app.config.fileStorageDriver === "local" ? app.config.fileStorageDir : undefined
    }, "file storage readiness check failed");
  }

  return status;
}
