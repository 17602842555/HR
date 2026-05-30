-- Data import runs preserve source checksum, row counts, and source-artifact
-- lineage. Corrections must be appended as a new run or audit event.
CREATE OR REPLACE FUNCTION prevent_data_import_run_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'data_import_runs are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER data_import_runs_prevent_update
BEFORE UPDATE ON "data_import_runs"
FOR EACH ROW EXECUTE FUNCTION prevent_data_import_run_mutation();

CREATE TRIGGER data_import_runs_prevent_delete
BEFORE DELETE ON "data_import_runs"
FOR EACH ROW EXECUTE FUNCTION prevent_data_import_run_mutation();
