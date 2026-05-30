-- Create finance request ledger for payment and expense documents linked to workflow instances.
CREATE TABLE "finance_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_no" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "applicant_user_id" TEXT,
    "department" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "vendor" TEXT,
    "payment_method" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "workflow_instance_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "finance_requests_tenant_id_request_no_key" ON "finance_requests"("tenant_id", "request_no");
CREATE INDEX "finance_requests_tenant_id_request_type_idx" ON "finance_requests"("tenant_id", "request_type");
CREATE INDEX "finance_requests_tenant_id_status_idx" ON "finance_requests"("tenant_id", "status");
CREATE INDEX "finance_requests_tenant_id_created_at_idx" ON "finance_requests"("tenant_id", "created_at");

ALTER TABLE "finance_requests" ADD CONSTRAINT "finance_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance_requests" ADD CONSTRAINT "finance_requests_applicant_user_id_fkey" FOREIGN KEY ("applicant_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "finance_requests" ADD CONSTRAINT "finance_requests_workflow_instance_id_fkey" FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
