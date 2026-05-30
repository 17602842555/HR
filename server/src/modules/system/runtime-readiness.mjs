import { checkAppendOnlyDatabaseTriggers } from "./database-integrity.mjs";

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
    status.ok = false;
    databaseReady = false;
    request.log.error({ error }, "database readiness check failed");
  }

  if (databaseReady) {
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
