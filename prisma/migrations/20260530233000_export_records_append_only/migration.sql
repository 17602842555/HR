-- Export records are part of the audit evidence trail. Corrections must be
-- represented by a new export/audit row instead of mutating history.
CREATE OR REPLACE FUNCTION prevent_export_record_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'export_records are append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER export_records_prevent_update
BEFORE UPDATE ON "export_records"
FOR EACH ROW EXECUTE FUNCTION prevent_export_record_mutation();

CREATE TRIGGER export_records_prevent_delete
BEFORE DELETE ON "export_records"
FOR EACH ROW EXECUTE FUNCTION prevent_export_record_mutation();
