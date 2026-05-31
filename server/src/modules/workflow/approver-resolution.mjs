export function normalizeApproverNameList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[，,]/);
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function identityLabels(user) {
  return [
    user?.name,
    user?.email,
    user?.employee?.name,
    user?.employee?.email
  ].map((item) => String(item || "").trim()).filter(Boolean);
}

function approverUserRecord(user, name) {
  return {
    name,
    userId: user?.id || null,
    email: user?.email || "",
    employeeId: user?.employeeId || user?.employee?.id || null
  };
}

export function approverUserIdForName(node, approverName) {
  const normalizedName = String(approverName || "").trim();
  if (!normalizedName) return null;
  const matched = (node?.approverUsers || []).find((item) => item.name === normalizedName);
  return matched?.userId || null;
}

export function buildApproverUserMap(users = []) {
  const map = new Map();
  for (const user of users) {
    for (const label of identityLabels(user)) {
      if (!map.has(label)) map.set(label, user);
    }
  }
  return map;
}

export async function loadApproverUserMap(prisma, tenantId, approverNames = []) {
  const names = normalizeApproverNameList(approverNames);
  if (!names.length || !prisma?.user?.findMany) return new Map();
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      OR: [
        { name: { in: names } },
        { email: { in: names } },
        { employee: { is: { name: { in: names } } } },
        { employee: { is: { email: { in: names } } } }
      ]
    },
    include: { employee: true }
  });
  return buildApproverUserMap(users);
}

export function enrichRuleNodesWithApproverUsers(nodes = [], approverUserMap = new Map()) {
  return nodes.map((node, index) => {
    const approvers = normalizeApproverNameList(node?.approvers);
    return {
      id: String(node?.id || `node-${index + 1}`).trim(),
      name: String(node?.name || `节点 ${index + 1}`).trim(),
      mode: "AND",
      approvers,
      approverUsers: approvers.map((name) => approverUserRecord(approverUserMap.get(name), name))
    };
  });
}

export async function enrichRuleNodesFromPrisma(prisma, tenantId, nodes = []) {
  const names = nodes.flatMap((node) => normalizeApproverNameList(node?.approvers));
  const approverUserMap = await loadApproverUserMap(prisma, tenantId, names);
  return enrichRuleNodesWithApproverUsers(nodes, approverUserMap);
}

export function approverResolutionSummary(nodes = []) {
  const approverUsers = nodes.flatMap((node) => node.approverUsers || []);
  const resolved = approverUsers.filter((item) => item.userId);
  const unresolved = approverUsers.filter((item) => !item.userId).map((item) => item.name);
  return {
    resolvedApproverCount: resolved.length,
    totalApproverCount: approverUsers.length,
    unresolvedApprovers: [...new Set(unresolved)]
  };
}

export function approvalRuleBindingError(nodes = [], { enabled = true } = {}) {
  if (enabled === false) return null;
  const resolution = approverResolutionSummary(nodes);
  if (!resolution.unresolvedApprovers.length) return null;
  return {
    error: "approval_rule_approvers_unresolved",
    message: `审批人未绑定真实账号：${resolution.unresolvedApprovers.join("、")}`,
    details: resolution
  };
}
