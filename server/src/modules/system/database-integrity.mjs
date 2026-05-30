export const requiredAppendOnlyTriggers = Object.freeze([
  "audit_logs_prevent_delete",
  "audit_logs_prevent_update",
  "data_import_runs_prevent_delete",
  "data_import_runs_prevent_update",
  "export_records_prevent_delete",
  "export_records_prevent_update"
]);

function quoteSqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function checkAppendOnlyDatabaseTriggers(prisma) {
  const triggerListSql = requiredAppendOnlyTriggers.map(quoteSqlLiteral).join(", ");
  const rows = await prisma.$queryRawUnsafe(`
    SELECT tgname
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (${triggerListSql})
    ORDER BY tgname
  `);
  const found = rows.map((row) => row.tgname).sort();
  const missing = requiredAppendOnlyTriggers.filter((name) => !found.includes(name));
  return {
    found,
    missing,
    ok: missing.length === 0,
    required: requiredAppendOnlyTriggers
  };
}
