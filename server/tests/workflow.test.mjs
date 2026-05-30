import test from "node:test";
import assert from "node:assert/strict";
import {
  approveWorkflowInstance,
  createWorkflowInstance,
  WorkflowNodeStatus,
  WorkflowStatus
} from "../src/modules/workflow/stateMachine.mjs";
import { createWorkflowApprovalService } from "../src/modules/workflow/approvalService.mjs";

const fixedClock = () => "2026-05-29T10:00:00.000Z";

function definition() {
  return {
    id: "expense",
    version: 3,
    rule: {
      id: "rule-expense-v3",
      version: 3,
      nodes: [
        {
          id: "manager-countersign",
          name: "部门会签",
          mode: "AND",
          approverIds: ["manager-a", "manager-b"]
        },
        {
          id: "finance-review",
          name: "财务复核",
          mode: "AND",
          approverIds: ["finance-owner"]
        }
      ]
    }
  };
}

function makePendingInstance() {
  return createWorkflowInstance({
    id: "wf-1",
    definition: definition(),
    applicantId: "applicant-1",
    payload: { amount: 980 },
    clock: fixedClock
  });
}

test("AND countersign stays on current node after first approver approves", () => {
  const instance = makePendingInstance();
  const result = approveWorkflowInstance(instance, {
    actorId: "manager-a",
    idempotencyKey: "approve-a",
    clock: fixedClock
  });

  assert.equal(result.changed, true);
  assert.equal(result.instance.status, WorkflowStatus.PENDING);
  assert.equal(result.instance.currentNodeIndex, 0);
  assert.equal(result.instance.nodes[0].status, WorkflowNodeStatus.PENDING);
  assert.equal(result.instance.nodes[0].approvers[0].status, "approved");
  assert.equal(result.instance.nodes[0].approvers[1].status, "pending");
  assert.equal(result.events[0].advanced, false);
});

test("AND countersign advances only after all current node approvers approve", () => {
  const first = approveWorkflowInstance(makePendingInstance(), {
    actorId: "manager-a",
    idempotencyKey: "approve-a",
    clock: fixedClock
  }).instance;

  const second = approveWorkflowInstance(first, {
    actorId: "manager-b",
    idempotencyKey: "approve-b",
    clock: fixedClock
  });

  assert.equal(second.changed, true);
  assert.equal(second.instance.status, WorkflowStatus.PENDING);
  assert.equal(second.instance.nodes[0].status, WorkflowNodeStatus.APPROVED);
  assert.equal(second.instance.currentNodeIndex, 1);
  assert.equal(second.instance.nodes[1].status, WorkflowNodeStatus.PENDING);
  assert.equal(second.events[0].advanced, true);
  assert.equal(second.events[0].nextNodeId, "finance-review");
});

test("repeated approve is idempotent and does not append history twice", () => {
  const instance = makePendingInstance();
  const first = approveWorkflowInstance(instance, {
    actorId: "manager-a",
    idempotencyKey: "approve-a",
    clock: fixedClock
  }).instance;
  const historyLength = first.history.length;

  const repeatedByKey = approveWorkflowInstance(first, {
    actorId: "manager-a",
    idempotencyKey: "approve-a",
    clock: fixedClock
  });

  assert.equal(repeatedByKey.changed, false);
  assert.equal(repeatedByKey.alreadyProcessed, true);
  assert.equal(repeatedByKey.instance.history.length, historyLength);

  const repeatedByActor = approveWorkflowInstance(first, {
    actorId: "manager-a",
    idempotencyKey: "approve-a-again",
    clock: fixedClock
  });

  assert.equal(repeatedByActor.changed, false);
  assert.equal(repeatedByActor.alreadyProcessed, true);
  assert.equal(repeatedByActor.instance.history.length, historyLength);
});

test("workflow instance keeps a rule snapshot after later rule mutation", () => {
  const sourceDefinition = definition();
  const instance = createWorkflowInstance({
    id: "wf-snapshot",
    definition: sourceDefinition,
    applicantId: "applicant-1",
    clock: fixedClock
  });

  sourceDefinition.rule.nodes[0].approverIds.push("late-added-manager");
  sourceDefinition.rule.nodes[0].name = "被后续规则改名";

  assert.deepEqual(instance.ruleSnapshot.nodes[0].approverIds, ["manager-a", "manager-b"]);
  assert.equal(instance.nodes[0].name, "部门会签");
  assert.throws(
    () => approveWorkflowInstance(instance, {
      actorId: "late-added-manager",
      idempotencyKey: "late-added-approve",
      clock: fixedClock
    }),
    /Approver is not assigned/
  );
});

test("final node approval completes the workflow", () => {
  const afterManagers = approveWorkflowInstance(
    approveWorkflowInstance(makePendingInstance(), {
      actorId: "manager-a",
      idempotencyKey: "approve-a",
      clock: fixedClock
    }).instance,
    {
      actorId: "manager-b",
      idempotencyKey: "approve-b",
      clock: fixedClock
    }
  ).instance;

  const result = approveWorkflowInstance(afterManagers, {
    actorId: "finance-owner",
    idempotencyKey: "approve-finance",
    clock: fixedClock
  });

  assert.equal(result.instance.status, WorkflowStatus.APPROVED);
  assert.equal(result.instance.currentNodeIndex, -1);
  assert.equal(result.instance.nodes[1].status, WorkflowNodeStatus.APPROVED);
});

test("approval service is transaction and idempotency friendly", async () => {
  const instances = new Map([["wf-1", makePendingInstance()]]);
  const idempotencyResults = new Map();
  const auditEvents = [];
  const calls = { transaction: 0, loadForUpdate: 0, save: 0 };
  const repository = {
    async transaction(work) {
      calls.transaction += 1;
      return work(this);
    },
    async findIdempotencyResult(key) {
      return idempotencyResults.get(key) ?? null;
    },
    async saveIdempotencyResult(key, result) {
      idempotencyResults.set(key, result);
    },
    async getWorkflowInstanceForUpdate(id) {
      calls.loadForUpdate += 1;
      return instances.get(id);
    },
    async saveWorkflowInstance(instance) {
      calls.save += 1;
      instances.set(instance.id, instance);
    },
    async appendAuditEvent(event) {
      auditEvents.push(event);
    }
  };
  const service = createWorkflowApprovalService({ repository, clock: fixedClock });

  const first = await service.approve({
    workflowId: "wf-1",
    actorId: "manager-a",
    idempotencyKey: "approve-service-a",
    comment: "同意"
  });
  const second = await service.approve({
    workflowId: "wf-1",
    actorId: "manager-a",
    idempotencyKey: "approve-service-a",
    comment: "同意"
  });

  assert.equal(first.changed, true);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(calls.transaction, 2);
  assert.equal(calls.loadForUpdate, 1);
  assert.equal(calls.save, 1);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].type, "workflow.approve");
});
