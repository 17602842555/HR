CREATE TABLE "account_activations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "role_codes" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "used_by_user_id" TEXT,
  "created_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "account_activations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_activations_tenant_id_token_hash_key" ON "account_activations"("tenant_id", "token_hash");
CREATE INDEX "account_activations_tenant_id_employee_id_status_idx" ON "account_activations"("tenant_id", "employee_id", "status");

ALTER TABLE "account_activations" ADD CONSTRAINT "account_activations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_activations" ADD CONSTRAINT "account_activations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
