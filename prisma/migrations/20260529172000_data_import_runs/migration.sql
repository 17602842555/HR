-- CreateTable
CREATE TABLE "data_import_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "source_type" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "source_checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "record_counts" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_import_runs_tenant_id_started_at_idx" ON "data_import_runs"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "data_import_runs_tenant_id_source_name_source_checksum_idx" ON "data_import_runs"("tenant_id", "source_name", "source_checksum");

-- AddForeignKey
ALTER TABLE "data_import_runs" ADD CONSTRAINT "data_import_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_import_runs" ADD CONSTRAINT "data_import_runs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
