import type {
  BossControlEnvelope,
  BossParticipantBinding,
  BossParticipantCredentialEnvelope,
  BossRunFeatureContract,
  BrokerCapabilityAdvertisement,
  ParticipantState,
  WorkerIdentityV2,
} from "@ctliz/agent-intercom-core/boss";

export interface BossParticipantRegistrationMetadata {
  featureContract: BossRunFeatureContract;
  credential: BossParticipantCredentialEnvelope;
}

/** Broker-owned metadata. Clients may request Boss registration but never assert a binding. */
export interface BossParticipantBindingMetadata {
  featureContract: BossRunFeatureContract;
  binding: BossParticipantBinding;
  brokerIdentityVerified: true;
  assignedParticipantIds?: string[];
  requestingPrincipalId?: string;
  /** Required by Boss roster projection before a session is discoverable. */
  workerIdentity?: WorkerIdentityV2;
  participantState?: ParticipantState;
}

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  origin?: "local" | "remote";
  remoteHostId?: string;
  parentSessionId?: string;
  rootSessionId?: string;
  generation?: number;
  canDelegate?: boolean;
  depth?: number;
  maxDepth?: number;
  maxChildren?: number;
  boss?: BossParticipantBindingMetadata;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    team?: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

type SessionRegistrationBase = Omit<
  SessionInfo,
  "id" | "peerUid" | "trustedLocal" | "origin" | "remoteHostId" | "parentSessionId" | "rootSessionId" | "generation" | "canDelegate" | "depth" | "maxDepth" | "maxChildren" | "boss"
> & {
  /** Ephemeral identity shared only by reconnects from one live runtime. */
  runtimeInstanceId?: string;
};

export type OrdinarySessionRegistration = SessionRegistrationBase & {
  boss?: never;
};

export type BossSessionRegistration = SessionRegistrationBase & {
  /** Optional untrusted request; only a protected, attested broker may return a binding. */
  boss: BossParticipantRegistrationMetadata;
};

export type SessionRegistration = OrdinarySessionRegistration | BossSessionRegistration;

export interface RemoteEnrollmentAccess {
  enrollmentToken: string;
}

export interface RemoteSessionAccess {
  sessionCredential: string;
  sessionId: string;
  generation: number;
}

export type RemoteRegistrationAccess = RemoteEnrollmentAccess | RemoteSessionAccess;

export interface RemoteAccessMetadata {
  origin: "remote";
  remoteHostId: string;
  parentSessionId: string;
  rootSessionId: string;
  generation: number;
  canDelegate: boolean;
  depth: number;
  maxDepth: number;
  maxChildren: number;
  sessionCredential?: string;
}

export interface RemotePrincipalSummary {
  id: string;
  name: string;
  parentSessionId: string;
  rootSessionId: string;
  remoteHostId: string;
  generation: number;
  policy: "remote-tree";
  canDelegate: boolean;
  depth: number;
  maxDepth: number;
  maxChildren: number;
  state: "active" | "revoked";
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  connected: boolean;
}

export interface RemoteAccessContract {
  feature: "remote-access-v1";
  policySemanticsVersion: number;
  policySemanticsHash: string;
}

export type DeliveryFailureCode =
  | "INVALID_MESSAGE"
  | "SESSION_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "SENDER_NOT_FOUND"
  | "INVALID_REPLY_TARGET"
  | "MUTUAL_ASK"
  | "ASK_ALREADY_PENDING"
  | "DUPLICATE_MESSAGE_ID"
  | "CONFLICTING_MESSAGE_ID"
  | "TOO_MANY_PENDING_DELIVERIES"
  | "TOO_MANY_PENDING_ASKS"
  | "RECIPIENT_DISCONNECTED"
  | "SENDER_DISCONNECTED"
  | "DELIVERY_TIMEOUT";

export type BossControlFailureCode =
  | "INVALID_CONTROL"
  | "IDEMPOTENCY_CONFLICT"
  | "SESSION_NOT_FOUND"
  | "POLICY_DENIED"
  | "RECIPIENT_DISCONNECTED"
  | "DELIVERY_TIMEOUT";

export type BrokerErrorCode =
  | "PROTOCOL_MISMATCH"
  | "INVALID_REQUEST"
  | "SESSION_ID_IN_USE"
  | "ACCESS_DENIED"
  | "REMOTE_ACCESS_INCOMPATIBLE"
  | "BOSS_FEATURE_UNAVAILABLE"
  | "BOSS_CONTRACT_MISMATCH"
  | "RATE_LIMITED"
  | "TOO_MANY_SESSIONS";

export type AskCancellationReason =
  | "cancelled"
  | "expired"
  | "delivery_failed"
  | "session_disconnected"
  | "authorization_revoked";

export type ClientMessage =
  | { type: "health"; requestId: string; stateId?: string }
  | { type: "register"; protocol: string; version: number; session: OrdinarySessionRegistration; sessionId?: string; stateId?: string; access?: RemoteRegistrationAccess; scopeId?: string }
  | { type: "register"; registrationKind: "boss"; protocol: string; version: number; session: BossSessionRegistration; sessionId?: string; stateId?: string; access?: never; scopeId?: string }
  | { type: "access_control"; requestId: string; adminToken: string; action: "issue_enrollment"; enrollment: { name: string; parentSessionId: string; rootSessionId: string; remoteHostId: string; ttlMs?: number; expiresAt?: number; canDelegate?: boolean; maxDepth?: number; maxChildren?: number } }
  | { type: "access_control"; requestId: string; adminToken: string; action: "revoke_subtree"; principalId: string }
  | { type: "access_control"; requestId: string; adminToken: string; action: "inspect_tree"; principalId: string }
  | { type: "access_control"; requestId: string; adminToken: string; action: "adopt_subtree"; principalId: string; newParentSessionId: string }
  | { type: "access_control"; requestId: string; access: RemoteSessionAccess; action: "issue_child_enrollment"; enrollment: { name: string; ttlMs?: number; expiresAt?: number; canDelegate?: boolean; maxDepth?: number; maxChildren?: number } }
  | { type: "access_control"; requestId: string; access: RemoteSessionAccess; action: "inspect_tree"; principalId?: string }
  | { type: "unregister"; preserveAsks?: boolean }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "boss_control"; requestId: string; to: string; envelope: BossControlEnvelope }
  | { type: "boss_control_received"; deliveryId: string; messageId: string; idempotencyKey: string }
  | { type: "message_received"; deliveryId: string }
  | { type: "message_rejected"; deliveryId: string; code: "CONFLICTING_MESSAGE_ID"; reason: string }
  | { type: "defer_ask"; requestId: string; messageId: string }
  | { type: "cancel_ask"; requestId: string; messageId: string }
  | { type: "presence"; name?: string; status?: string; model?: string };

export type BrokerMessage =
  | { type: "health_ok"; requestId: string; protocol: string; version: number; endpoint: "local" | "remote"; remoteAccess?: RemoteAccessContract; capabilities?: BrokerCapabilityAdvertisement }
  | { type: "registered"; sessionId: string; protocol: string; version: number; remoteAccess?: RemoteAccessContract; access?: RemoteAccessMetadata }
  | { type: "registered"; registrationKind: "boss"; sessionId: string; protocol: string; version: number; capabilities: BrokerCapabilityAdvertisement; boss: BossParticipantBindingMetadata; remoteAccess?: never; access?: never }
  | { type: "access_control_result"; requestId: string; action: "issue_enrollment"; enrollmentToken: string; expiresAt: number }
  | { type: "access_control_result"; requestId: string; action: "revoke_subtree"; changedPrincipalIds: string[] }
  | { type: "access_control_result"; requestId: string; action: "inspect_tree"; principals: RemotePrincipalSummary[] }
  | { type: "access_control_result"; requestId: string; action: "adopt_subtree"; principals: RemotePrincipalSummary[] }
  | { type: "access_control_result"; requestId: string; action: "issue_child_enrollment"; enrollmentToken: string; expiresAt: number; parentSessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; deliveryId: string; from: SessionInfo; message: Message }
  | { type: "boss_control"; deliveryId: string; from: SessionInfo; envelope: BossControlEnvelope }
  | { type: "boss_control_ack"; requestId: string; messageId: string; idempotencyKey: string; status: "accepted"; deliveryId: string }
  | { type: "boss_control_result"; requestId: string; messageId: string; idempotencyKey: string; status: "delivered"; delivered: true; deliveryId: string }
  | { type: "boss_control_result"; requestId: string; messageId: string; idempotencyKey: string; status: "rejected"; delivered: false; deliveryId?: string; code: BossControlFailureCode; reason: string }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; code: BrokerErrorCode; error: string }
  | { type: "delivery_accepted"; messageId: string; deliveryId: string }
  | { type: "delivered"; messageId: string; deliveryId: string }
  | { type: "delivery_failed"; messageId: string; accepted: boolean; code: DeliveryFailureCode; reason: string }
  | { type: "ask_deferred"; messageId: string; fromSessionId: string }
  | { type: "ask_cancelled"; messageId: string; fromSessionId: string; reason: AskCancellationReason }
  | { type: "ask_control_result"; requestId: string; action: "defer" | "cancel"; messageId: string; applied: boolean };
