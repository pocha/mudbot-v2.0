/** One entry in a conversation dump — same shape ingestCore/seed-conversation.ts
 * expect, so a dump can be replayed without any reshaping. Built from
 * Store-based data (see content-script.ts's toDumpedMessage). */
export interface DumpedMessage {
  jid: string;
  displayName: string;
  text: string;
  direction: "incoming" | "outgoing";
  timestamp: string; // ISO 8601
}

/** One row in the popup's chat picker. */
export interface ChatSummary {
  jid: string;
  displayName: string;
  lastMessageAt: string; // ISO 8601, for sorting/display in the picker
}
