/**
 * Everything WhatsApp-Web-DOM-specific lives behind this interface. web.whatsapp.com's
 * DOM is unofficial, obfuscated, and changes without notice — rather than guess at
 * selectors here, this is a seam to fill in after inspecting the live page in devtools.
 * Keeping it isolated means a DOM change only requires editing this one file.
 */
export interface ObservedMessage {
  jid: string;
  displayName: string;
  text: string;
  direction: "incoming" | "outgoing";
}

/** One entry in a conversation dump — same shape ingestCore/train-from-dump.ts
 * expect, so a dump can be replayed without any reshaping. */
export interface DumpedMessage extends ObservedMessage {
  timestamp: string; // ISO 8601
}

/** One row in the popup's chat picker. */
export interface ChatSummary {
  jid: string;
  displayName: string;
  lastMessageAt: string; // ISO 8601, for sorting/display in the picker
}

export interface WhatsAppAdapter {
  /** Start watching the currently open/visible chat(s) for new messages, calling
   * onMessage for each one seen for the first time. */
  observe(onMessage: (msg: ObservedMessage) => void): void;

  /** Open (or focus) the chat for a given jid, type `text` into the composer, and
   * send it — used both for real actions and for assistant-chat notifications. */
  sendMessage(jid: string, text: string): Promise<void>;

  /** List the `limit` most recently active chats, for the popup's dump picker —
   * WhatsApp doesn't expose a "pick chats to back up" feature itself, so this is
   * how the owner narrows down to just business conversations before dumping. */
  listRecentChats(limit: number): Promise<ChatSummary[]>;

  /** Scrape full available history for each of the given chats (by jid) and
   * return one merged, per-message-tagged array — training/offline-testing
   * input, see scripts/train-from-dump.ts and scripts/simulate.ts. Since this
   * has to open/focus each chat in turn to scrape it (WhatsApp Web lazy-loads
   * history as you scroll up), expect this to take real wall-clock time for
   * more than a handful of chats. */
  dumpHistory(jids: string[]): Promise<DumpedMessage[]>;

  /** jid of WhatsApp's own "Message Yourself" self-chat for the logged-in
   * account — the recommended default assistant channel, so the owner doesn't
   * need a second phone number/WhatsApp account just to talk to the assistant. */
  getSelfJid(): Promise<string | null>;
}

/**
 * TODO: fill in with real selectors/logic once you've inspected web.whatsapp.com:
 * - a MutationObserver on the message-list container, tagging each new message
 *   node with the open chat's jid/name and incoming/outgoing based on which side
 *   of the bubble it renders on
 * - the chat-list sidebar DOM, sorted by recency, to back listRecentChats()
 * - a way to look up a chat by jid/display name (search box) and focus it, plus
 *   scrolling the message list upward to lazy-load full history, for dumpHistory()
 * - the composer's contenteditable element and send-button selector
 * This stub exists so background.ts and the message-passing plumbing around it
 * can be built and tested independently of the DOM work.
 */
export function createWhatsAppAdapter(): WhatsAppAdapter {
  return {
    observe(_onMessage) {
      console.warn("[mudbot-v2.0] WhatsAppAdapter.observe() not implemented yet");
    },
    async sendMessage(_jid, _text) {
      console.warn("[mudbot-v2.0] WhatsAppAdapter.sendMessage() not implemented yet");
    },
    async listRecentChats(_limit) {
      console.warn("[mudbot-v2.0] WhatsAppAdapter.listRecentChats() not implemented yet");
      return [];
    },
    async dumpHistory(_jids) {
      console.warn("[mudbot-v2.0] WhatsAppAdapter.dumpHistory() not implemented yet");
      return [];
    },
    async getSelfJid() {
      console.warn("[mudbot-v2.0] WhatsAppAdapter.getSelfJid() not implemented yet");
      return null;
    },
  };
}
