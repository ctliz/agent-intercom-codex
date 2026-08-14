import test from "node:test";
import assert from "node:assert/strict";
import { chooseContactTarget, formatContactInstruction, resolveContactTarget } from "./contact.ts";
import type { SessionInfo } from "../types.ts";

function session(id: string, name?: string): SessionInfo {
  return {
    id,
    ...(name ? { name } : {}),
    cwd: "/tmp/project",
    model: "codex",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  };
}

test("chooseContactTarget prefers a unique session name", () => {
  const current = session("codex-worker-123", "worker");
  const contact = chooseContactTarget(current, [current, session("pi-planner", "planner")]);
  assert.deepEqual(contact, {
    target: "worker",
    id: "codex-worker-123",
    name: "worker",
    duplicateName: false,
  });
  assert.equal(
    formatContactInstruction(contact),
    "Intercom send ID: worker (full ID: codex-worker-123)",
  );
});

test("formatContactInstruction returns full ID when target is the id", () => {
  assert.equal(
    formatContactInstruction({ target: "codex-worker-123", id: "codex-worker-123" }),
    "Intercom send ID: codex-worker-123",
  );
});

test("chooseContactTarget falls back to the id for duplicate names", () => {
  const current = session("codex-worker-123", "worker");
  const contact = chooseContactTarget(current, [current, session("pi-worker", "WORKER")]);
  assert.equal(contact.target, "codex-worker-123");
  assert.equal(contact.duplicateName, true);
});

test("resolveContactTarget uses the stable id when discovery fails", async () => {
  const contact = await resolveContactTarget("codex-worker-123", "worker", async () => {
    throw new Error("broker unavailable");
  });
  assert.deepEqual(contact, {
    target: "codex-worker-123",
    id: "codex-worker-123",
    name: "worker",
    duplicateName: false,
    fallback: true,
  });
});
