-- Prevent retried workflow submissions from creating duplicate approval instances.

ALTER TABLE "workflow_instances" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "workflow_instances_tenant_id_idempotency_key_key"
ON "workflow_instances"("tenant_id", "idempotency_key");
