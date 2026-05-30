import { createAuditEvent } from "../audit/redaction.mjs";
import { approveWorkflowInstance, rejectWorkflowInstance } from "./stateMachine.mjs";

function requireMethod(repository, name) {
  if (typeof repository?.[name] !== "function") {
    throw new Error(`Workflow repository must implement ${name}().`);
  }
  return repository[name].bind(repository);
}

async function runTransaction(repository, work) {
  if (typeof repository.transaction === "function") {
    return repository.transaction(work);
  }
  return work(repository);
}

async function readIdempotency(repository, key) {
  if (!key || typeof repository.findIdempotencyResult !== "function") return null;
  return repository.findIdempotencyResult(key);
}

async function writeIdempotency(repository, key, result) {
  if (!key || typeof repository.saveIdempotencyResult !== "function") return;
  await repository.saveIdempotencyResult(key, result);
}

export function createWorkflowApprovalService({ repository, clock = () => new Date().toISOString() }) {
  return {
    approve(command) {
      return runTransaction(repository, async (tx) => {
        const cached = await readIdempotency(tx, command.idempotencyKey);
        if (cached) return { ...cached, alreadyProcessed: true };

        const getForUpdate = requireMethod(tx, "getWorkflowInstanceForUpdate");
        const save = requireMethod(tx, "saveWorkflowInstance");
        const instance = await getForUpdate(command.workflowId);
        const result = approveWorkflowInstance(instance, {
          actorId: command.actorId,
          approverId: command.approverId ?? command.actorId,
          comment: command.comment,
          idempotencyKey: command.idempotencyKey,
          clock
        });

        if (result.changed) await save(result.instance);
        if (typeof tx.appendAuditEvent === "function") {
          await tx.appendAuditEvent(createAuditEvent({
            type: "workflow.approve",
            actorId: command.actorId,
            objectType: "workflow",
            objectId: command.workflowId,
            payload: {
              command,
              events: result.events,
              workflowStatus: result.instance.status
            },
            occurredAt: clock()
          }));
        }
        await writeIdempotency(tx, command.idempotencyKey, result);
        return result;
      });
    },

    reject(command) {
      return runTransaction(repository, async (tx) => {
        const cached = await readIdempotency(tx, command.idempotencyKey);
        if (cached) return { ...cached, alreadyProcessed: true };

        const getForUpdate = requireMethod(tx, "getWorkflowInstanceForUpdate");
        const save = requireMethod(tx, "saveWorkflowInstance");
        const instance = await getForUpdate(command.workflowId);
        const result = rejectWorkflowInstance(instance, {
          actorId: command.actorId,
          approverId: command.approverId ?? command.actorId,
          comment: command.comment,
          idempotencyKey: command.idempotencyKey,
          clock
        });

        if (result.changed) await save(result.instance);
        if (typeof tx.appendAuditEvent === "function") {
          await tx.appendAuditEvent(createAuditEvent({
            type: "workflow.reject",
            actorId: command.actorId,
            objectType: "workflow",
            objectId: command.workflowId,
            payload: {
              command,
              events: result.events,
              workflowStatus: result.instance.status
            },
            occurredAt: clock()
          }));
        }
        await writeIdempotency(tx, command.idempotencyKey, result);
        return result;
      });
    }
  };
}

