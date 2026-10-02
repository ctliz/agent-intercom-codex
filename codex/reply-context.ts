import type { PendingInboundMessage, ReplyWhich } from "./runtime.ts";
import { selectPendingAsk } from "./runtime.ts";

export function contextId(entry: PendingInboundMessage): string {
  return `ctx-${entry.message.id}`;
}

export function askId(entry: PendingInboundMessage): string {
  return `ask-${entry.message.id}`;
}

export function replyHint(entry: PendingInboundMessage): string {
  const team = entry.message.content.team;
  return `${team ? ` [Team: ${team}]` : ""} [contextId: ${contextId(entry)}]${entry.message.expectsReply ? ` [askId: ${askId(entry)}]` : ""}`;
}

/** Select from the receiver's own retained inbox, never from a mutable current team. */
export function selectReplyContext(entries: PendingInboundMessage[], asks: PendingInboundMessage[], input: {
  to?: string;
  which?: ReplyWhich;
  askId?: string;
  contextId?: string;
  team?: string;
}): PendingInboundMessage {
  if (input.askId && input.contextId) throw new Error("Specify askId or contextId, not both");
  let target: PendingInboundMessage;
  if (input.askId || input.contextId) {
    const selected = input.askId
      ? asks.find((entry) => askId(entry) === input.askId)
      : entries.find((entry) => contextId(entry) === input.contextId);
    if (!selected || (selected.message.expectsReply && !asks.includes(selected))) throw new Error("Unknown or resolved reply selector; call intercom_pending");
    if (input.to && selected.from.id !== input.to && selected.from.name?.toLowerCase() !== input.to.toLowerCase()) {
      throw new Error("Reply sender does not match the selected context");
    }
    if (input.which) throw new Error("Do not combine an exact reply selector with which");
    target = selected;
  } else {
    const to = input.to;
    const candidates = to ? asks.filter((entry) => entry.from.id === to || entry.from.name?.toLowerCase() === to.toLowerCase() || entry.from.id.startsWith(to)) : asks;
    if (!input.which && new Set(candidates.map((entry) => entry.message.content.team)).size > 1) {
      throw new Error("Multiple team contexts; specify askId or contextId");
    }
    target = selectPendingAsk(asks, input.to, input.which);
  }
  if (input.team !== undefined && input.team !== target.message.content.team) {
    throw new Error("Reply team must match the original message; omit team to inherit it");
  }
  return target;
}
