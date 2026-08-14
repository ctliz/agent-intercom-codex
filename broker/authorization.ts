import { type AuthorizationDecision, type PolicyAction, type PolicyPrincipal, type PolicyState } from "@ctliz/agent-intercom-core";
import type {
  BossAuthorizationContext,
  BossPolicyAction,
  FeatureAwareAuthorizationDecision,
} from "@ctliz/agent-intercom-core/boss";
import type { SessionInfo } from "../types.ts";
import { authorizeBossAwareSessionAction } from "./boss-adapter.ts";

export function policyPrincipalForSession(session: SessionInfo): PolicyPrincipal {
  if (session.origin === "remote") {
    if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
      throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
    }
    return {
      id: session.id,
      kind: "remote",
      state: "active",
      generation: session.generation,
      policy: "remote-tree",
      parentSessionId: session.parentSessionId,
      rootSessionId: session.rootSessionId,
    };
  }
  return {
    id: session.id,
    kind: "local",
    state: "active",
    generation: 1,
    policy: "local-public",
    rootSessionId: session.id,
  };
}

export function policyStateForSessions(sessions: Iterable<SessionInfo>): PolicyState {
  const principals: Record<string, PolicyPrincipal> = {};
  for (const session of sessions) principals[session.id] = policyPrincipalForSession(session);
  return { principals };
}

export function authorizeSessionAction(
  sessions: Iterable<SessionInfo>,
  actorId: string,
  action: PolicyAction | BossPolicyAction,
  targetId: string,
  bossContext?: BossAuthorizationContext,
): AuthorizationDecision | FeatureAwareAuthorizationDecision {
  return authorizeBossAwareSessionAction(sessions, actorId, action, targetId, bossContext);
}

export function visibleSessions(sessions: Iterable<SessionInfo>, actorId: string): SessionInfo[] {
  const values = Array.from(sessions);
  return values.filter((target) => authorizeSessionAction(values, actorId, "discover", target.id).allowed);
}
