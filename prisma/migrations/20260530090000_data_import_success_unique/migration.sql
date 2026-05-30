-- Prevent concurrent successful imports from creating duplicate lineage rows.
-- Failed or superseded import attempts may still be retained for diagnostics.
CREATE UNIQUE INDEX "data_import_runs_success_unique"
ON "data_import_runs"("tenant_id", "source_name", "source_checksum")
WHERE "status" = 'SUCCESS';
