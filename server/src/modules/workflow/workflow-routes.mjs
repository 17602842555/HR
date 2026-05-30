import { requirePermission } from "../iam/route-guards.mjs";

export async function registerWorkflowRoutes(app) {
  app.get("/api/workflows/definitions", { preHandler: app.authenticate }, async (request) => {
    await requirePermission(app, request, { module: "workflow", action: "read" });
    const definitions = await app.prisma.workflowDefinition.findMany({
      where: {
        tenantId: request.user.tenantId,
        status: "ACTIVE"
      },
      include: {
        nodes: {
          orderBy: { stepOrder: "asc" }
        }
      },
      orderBy: [
        { category: "asc" },
        { name: "asc" }
      ]
    });

    return { definitions };
  });
}
