ALTER TABLE "role_permissions"
  ADD COLUMN "data_scope" JSONB,
  ADD COLUMN "field_policy" JSONB,
  ADD COLUMN "allow_export" BOOLEAN NOT NULL DEFAULT false;
