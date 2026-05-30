import { deepClone } from "../../lib/clone.mjs";
import { DomainError, invariant } from "../../lib/domainErrors.mjs";

export const WorkflowStatus = Object.freeze({
  DRAFT: "draft",
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
  CANCELED: "canceled"
});

export const WorkflowNodeStatus = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  SKIPPED: "skipped"
});

export const ApproverDecisionStatus = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  SKIPPED: "skipped"
});

const TERMINAL_WORKFLOW_STATUSES = new Set([
  WorkflowStatus.APPROVED,
  WorkflowStatus.REJECTED,
  WorkflowStatus.WITHDRAWN,
  WorkflowStatus.CANCELED
]);

function nowIso(clock) {
  if (typeof clock === "function") return clock();
  return new Date().toISOString();
}

function ensureAndMode(node) {
  const mode = node.mode || "AND";
  invariant(mode === "AND", "UNSUPPORTED_APPROVAL_MODE", "Only AND countersign nodes are supported.", {
    nodeId: node.id,
    mode
  });
  return mode;
}

function normalizeApproverIds(node) {
  return [...new Set((node.approverIds ?? node.approvers ?? []).filter(Boolean).map(String))];
}

function normalizeRuleSnapshot(definition) {
  const sourceNodes = definition.ruleSnapshot?.nodes ?? definition.rule?.nodes ?? definition.nodes ?? [];
  return {
    id: definition.ruleSnapshot?.id ?? definition.rule?.id ?? definition.id,
    version: definition.ruleSnapshot?.version ?? definition.rule?.version ?? definition.version ?? 1,
    nodes: sourceNodes.map((node, index) => {
      const approverIds = normalizeApproverIds(node);
      return {
        id: node.id ?? `node-${index + 1}`,
        name: node.name ?? `Approval Node ${index + 1}`,
        mode: ensureAndMode(node),
        approverIds,
        skipWhenNoApprover: node.skipWhenNoApprover !== false
      };
    })
  };
}

function instantiateNode(node) {
  const skipped = node.approverIds.length === 0 && node.skipWhenNoApprover;
  return {
    id: node.id,
    name: node.name,
    mode: node.mode,
    status: skipped ? WorkflowNodeStatus.SKIPPED : WorkflowNodeStatus.PENDING,
    approvers: node.approverIds.map((approverId) => ({
      approverId,
      status: ApproverDecisionStatus.PENDING,
      actedAt: null,
      comment: "",
      idempotencyKey: ""
    }))
  };
}

function firstActiveNodeIndex(nodes) {
  return nodes.findIndex((node) => node.status === WorkflowNodeStatus.PENDING);
}

function operationKeyExists(instance, key) {
  if (!key) return false;
  return (instance.operationKeys || []).some((item) => item.key === key);
}

function appendHistory(instance, entry) {
  return {
    ...instance,
    history: [
      ...(instance.history || []),
      {
        id: `${entry.type}-${(instance.history || []).length + 1}`,
        ...entry
      }
    ]
  };
}

function appendOperationKey(instance, key, command, actorId, occurredAt) {
  if (!key) return instance;
  return {
    ...instance,
    operationKeys: [
      ...(instance.operationKeys || []),
      { key, command, actorId, occurredAt }
    ]
  };
}

function findNextPendingNodeIndex(nodes, fromIndex) {
  for (let index = fromIndex + 1; index < nodes.length; index += 1) {
    if (nodes[index].status === WorkflowNodeStatus.PENDING) return index;
  }
  return -1;
}

export function createWorkflowInstance({
  id,
  definition,
  applicantId,
  payload = {},
  status = WorkflowStatus.PENDING,
  clock
}) {
  invariant(definition, "WORKFLOW_DEFINITION_REQUIRED", "Workflow definition is required.");
  invariant(Object.values(WorkflowStatus).includes(status), "INVALID_WORKFLOW_STATUS", "Unsupported workflow status.", { status });

  const occurredAt = nowIso(clock);
  const ruleSnapshot = deepClone(normalizeRuleSnapshot(definition));
  const nodes = ruleSnapshot.nodes.map(instantiateNode);
  const currentNodeIndex = status === WorkflowStatus.PENDING ? firstActiveNodeIndex(nodes) : -1;
  const effectiveStatus = currentNodeIndex === -1 && status === WorkflowStatus.PENDING
    ? WorkflowStatus.APPROVED
    : status;

  return {
    id,
    definitionId: definition.id,
    definitionVersion: definition.version ?? 1,
    applicantId,
    status: effectiveStatus,
    currentNodeIndex: effectiveStatus === WorkflowStatus.PENDING ? currentNodeIndex : -1,
    ruleSnapshot,
    payload: deepClone(payload),
    nodes,
    operationKeys: [],
    history: [
      {
        id: "workflow-created-1",
        type: status === WorkflowStatus.DRAFT ? "workflow.created" : "workflow.submitted",
        actorId: applicantId,
        occurredAt,
        fromStatus: null,
        toStatus: effectiveStatus
      }
    ],
    createdAt: occurredAt,
    updatedAt: occurredAt
  };
}

export function submitWorkflowInstance(instance, { actorId, idempotencyKey, clock } = {}) {
  if (operationKeyExists(instance, idempotencyKey)) {
    return { instance, changed: false, alreadyProcessed: true, events: [] };
  }
  invariant(instance.status === WorkflowStatus.DRAFT, "WORKFLOW_NOT_DRAFT", "Only draft workflow instances can be submitted.", {
    workflowId: instance.id,
    status: instance.status
  });

  const occurredAt = nowIso(clock);
  const nextPendingIndex = firstActiveNodeIndex(instance.nodes || []);
  const nextStatus = nextPendingIndex === -1 ? WorkflowStatus.APPROVED : WorkflowStatus.PENDING;
  let next = {
    ...instance,
    status: nextStatus,
    currentNodeIndex: nextStatus === WorkflowStatus.PENDING ? nextPendingIndex : -1,
    updatedAt: occurredAt
  };
  next = appendOperationKey(next, idempotencyKey, "submit", actorId, occurredAt);
  next = appendHistory(next, {
    type: "workflow.submitted",
    actorId,
    occurredAt,
    fromStatus: WorkflowStatus.DRAFT,
    toStatus: nextStatus
  });
  return { instance: next, changed: true, alreadyProcessed: false, events: [next.history.at(-1)] };
}

export function approveWorkflowInstance(instance, { actorId, approverId = actorId, comment = "", idempotencyKey, clock } = {}) {
  if (operationKeyExists(instance, idempotencyKey)) {
    return { instance, changed: false, alreadyProcessed: true, events: [] };
  }
  invariant(instance.status === WorkflowStatus.PENDING, "WORKFLOW_NOT_PENDING", "Only pending workflow instances can be approved.", {
    workflowId: instance.id,
    status: instance.status
  });

  const nodeIndex = instance.currentNodeIndex;
  const node = instance.nodes?.[nodeIndex];
  invariant(node, "ACTIVE_WORKFLOW_NODE_NOT_FOUND", "Active workflow node is missing.", {
    workflowId: instance.id,
    currentNodeIndex: nodeIndex
  });
  invariant(node.status === WorkflowNodeStatus.PENDING, "WORKFLOW_NODE_NOT_PENDING", "Active workflow node is not pending.", {
    workflowId: instance.id,
    nodeId: node.id,
    nodeStatus: node.status
  });

  const approver = node.approvers.find((item) => String(item.approverId) === String(approverId));
  invariant(approver, "APPROVER_NOT_ASSIGNED", "Approver is not assigned to the active workflow node.", {
    workflowId: instance.id,
    nodeId: node.id,
    approverId
  });

  if (approver.status === ApproverDecisionStatus.APPROVED) {
    return { instance, changed: false, alreadyProcessed: true, events: [] };
  }

  const occurredAt = nowIso(clock);
  const nodes = instance.nodes.map((item, index) => {
    if (index !== nodeIndex) return item;
    const nextApprovers = item.approvers.map((decision) => (
      String(decision.approverId) === String(approverId)
        ? {
            ...decision,
            status: ApproverDecisionStatus.APPROVED,
            actedAt: occurredAt,
            comment,
            idempotencyKey: idempotencyKey || ""
          }
        : decision
    ));
    const allApproved = nextApprovers.every((decision) => decision.status === ApproverDecisionStatus.APPROVED);
    return {
      ...item,
      status: allApproved ? WorkflowNodeStatus.APPROVED : WorkflowNodeStatus.PENDING,
      approvers: nextApprovers
    };
  });

  const currentNodeApproved = nodes[nodeIndex].status === WorkflowNodeStatus.APPROVED;
  const nextPendingIndex = currentNodeApproved ? findNextPendingNodeIndex(nodes, nodeIndex) : nodeIndex;
  const nextWorkflowStatus = currentNodeApproved && nextPendingIndex === -1
    ? WorkflowStatus.APPROVED
    : WorkflowStatus.PENDING;
  const nextCurrentNodeIndex = nextWorkflowStatus === WorkflowStatus.PENDING ? nextPendingIndex : -1;

  let next = {
    ...instance,
    status: nextWorkflowStatus,
    currentNodeIndex: nextCurrentNodeIndex,
    nodes,
    updatedAt: occurredAt
  };
  next = appendOperationKey(next, idempotencyKey, "approve", actorId, occurredAt);
  next = appendHistory(next, {
    type: "workflow.approved",
    actorId,
    approverId,
    occurredAt,
    nodeId: node.id,
    nodeName: node.name,
    fromStatus: instance.status,
    toStatus: nextWorkflowStatus,
    advanced: currentNodeApproved,
    nextNodeId: nodes[nextCurrentNodeIndex]?.id ?? null
  });

  return { instance: next, changed: true, alreadyProcessed: false, events: [next.history.at(-1)] };
}

export function rejectWorkflowInstance(instance, { actorId, approverId = actorId, comment = "", idempotencyKey, clock } = {}) {
  if (operationKeyExists(instance, idempotencyKey)) {
    return { instance, changed: false, alreadyProcessed: true, events: [] };
  }
  invariant(instance.status === WorkflowStatus.PENDING, "WORKFLOW_NOT_PENDING", "Only pending workflow instances can be rejected.", {
    workflowId: instance.id,
    status: instance.status
  });

  const occurredAt = nowIso(clock);
  const nodeIndex = instance.currentNodeIndex;
  const node = instance.nodes?.[nodeIndex];
  invariant(node, "ACTIVE_WORKFLOW_NODE_NOT_FOUND", "Active workflow node is missing.", {
    workflowId: instance.id,
    currentNodeIndex: nodeIndex
  });

  const approver = node.approvers.find((item) => String(item.approverId) === String(approverId));
  invariant(approver, "APPROVER_NOT_ASSIGNED", "Approver is not assigned to the active workflow node.", {
    workflowId: instance.id,
    nodeId: node.id,
    approverId
  });

  let next = {
    ...instance,
    status: WorkflowStatus.REJECTED,
    currentNodeIndex: -1,
    nodes: instance.nodes.map((item, index) => index === nodeIndex
      ? {
          ...item,
          status: WorkflowNodeStatus.REJECTED,
          approvers: item.approvers.map((decision) => String(decision.approverId) === String(approverId)
            ? {
                ...decision,
                status: ApproverDecisionStatus.REJECTED,
                actedAt: occurredAt,
                comment,
                idempotencyKey: idempotencyKey || ""
              }
            : decision)
        }
      : item),
    updatedAt: occurredAt
  };
  next = appendOperationKey(next, idempotencyKey, "reject", actorId, occurredAt);
  next = appendHistory(next, {
    type: "workflow.rejected",
    actorId,
    approverId,
    occurredAt,
    nodeId: node.id,
    nodeName: node.name,
    fromStatus: instance.status,
    toStatus: WorkflowStatus.REJECTED
  });
  return { instance: next, changed: true, alreadyProcessed: false, events: [next.history.at(-1)] };
}

export function withdrawWorkflowInstance(instance, { actorId, idempotencyKey, clock } = {}) {
  if (operationKeyExists(instance, idempotencyKey)) {
    return { instance, changed: false, alreadyProcessed: true, events: [] };
  }
  invariant(!TERMINAL_WORKFLOW_STATUSES.has(instance.status), "WORKFLOW_ALREADY_TERMINAL", "Terminal workflow instances cannot be withdrawn.", {
    workflowId: instance.id,
    status: instance.status
  });

  const occurredAt = nowIso(clock);
  let next = {
    ...instance,
    status: WorkflowStatus.WITHDRAWN,
    currentNodeIndex: -1,
    updatedAt: occurredAt
  };
  next = appendOperationKey(next, idempotencyKey, "withdraw", actorId, occurredAt);
  next = appendHistory(next, {
    type: "workflow.withdrawn",
    actorId,
    occurredAt,
    fromStatus: instance.status,
    toStatus: WorkflowStatus.WITHDRAWN
  });
  return { instance: next, changed: true, alreadyProcessed: false, events: [next.history.at(-1)] };
}

export function cancelWorkflowInstance(instance, { actorId, idempotencyKey, clock } = {}) {
  if (operationKeyExists(instance, idempotencyKey)) {
    return { instance, changed: false, alreadyProcessed: true, events: [] };
  }
  invariant(!TERMINAL_WORKFLOW_STATUSES.has(instance.status), "WORKFLOW_ALREADY_TERMINAL", "Terminal workflow instances cannot be canceled.", {
    workflowId: instance.id,
    status: instance.status
  });

  const occurredAt = nowIso(clock);
  let next = {
    ...instance,
    status: WorkflowStatus.CANCELED,
    currentNodeIndex: -1,
    updatedAt: occurredAt
  };
  next = appendOperationKey(next, idempotencyKey, "cancel", actorId, occurredAt);
  next = appendHistory(next, {
    type: "workflow.canceled",
    actorId,
    occurredAt,
    fromStatus: instance.status,
    toStatus: WorkflowStatus.CANCELED
  });
  return { instance: next, changed: true, alreadyProcessed: false, events: [next.history.at(-1)] };
}

export function assertWorkflowState(instance) {
  invariant(Object.values(WorkflowStatus).includes(instance.status), "INVALID_WORKFLOW_STATUS", "Workflow has an invalid status.", {
    workflowId: instance.id,
    status: instance.status
  });
  for (const node of instance.nodes || []) {
    invariant(Object.values(WorkflowNodeStatus).includes(node.status), "INVALID_WORKFLOW_NODE_STATUS", "Workflow node has an invalid status.", {
      workflowId: instance.id,
      nodeId: node.id,
      status: node.status
    });
  }
  return instance;
}

export { DomainError };

