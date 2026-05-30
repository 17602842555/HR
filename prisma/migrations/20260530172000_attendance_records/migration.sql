CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "check_in_at" TIMESTAMP(3),
    "check_out_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'NORMAL',
    "minutes_late" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attendance_records_tenant_id_work_date_idx" ON "attendance_records"("tenant_id", "work_date");
CREATE INDEX "attendance_records_tenant_id_status_idx" ON "attendance_records"("tenant_id", "status");
CREATE INDEX "attendance_records_tenant_id_employee_name_idx" ON "attendance_records"("tenant_id", "employee_name");

ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
