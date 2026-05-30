-- CreateTable
CREATE TABLE "export_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "file_name" TEXT,
    "format" TEXT NOT NULL DEFAULT 'csv',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "export_records_tenant_id_created_at_idx" ON "export_records"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "export_records_tenant_id_action_idx" ON "export_records"("tenant_id", "action");

-- CreateIndex
CREATE INDEX "export_records_tenant_id_actor_user_id_idx" ON "export_records"("tenant_id", "actor_user_id");

-- AddForeignKey
ALTER TABLE "export_records" ADD CONSTRAINT "export_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_records" ADD CONSTRAINT "export_records_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
