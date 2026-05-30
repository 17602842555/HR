ALTER TABLE "payroll_batches" ADD COLUMN "workflow_instance_id" TEXT;

CREATE INDEX "leave_requests_tenant_id_workflow_instance_id_idx" ON "leave_requests"("tenant_id", "workflow_instance_id");
CREATE INDEX "payroll_batches_tenant_id_workflow_instance_id_idx" ON "payroll_batches"("tenant_id", "workflow_instance_id");

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_workflow_instance_id_fkey" FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_workflow_instance_id_fkey" FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
