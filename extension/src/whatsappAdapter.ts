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

export interface WhatsAppAdapter {
  /** Start watching the currently open/visible chat(s) for new messages, calling
   * onMessage for each one seen for the first time. */
  observe(onMessage: (msg: ObservedMessage) => void): void;

  /** Open (or focus) the chat for a given jid, type `text` into the composer, and
   * send it — used both for real actions and for assistant-chat notifications. */
  sendMessage(jid: string, text: string): Promise<void>;

  /** Scrape full available history for the currently open chat(s), for the
   * popup's "Dump conversation" button — offline-testing input, see
   * scripts/train-from-dump.ts and scripts/simulate.ts. */
  dumpHistory(): Promise<DumpedMessage[]>;
}

/**
 * TODO: fill in with real selectors/logic once you've inspected web.whatsapp.com:
 * - a MutationObserver on the message-list container, tagging each new message
 *   node with the open chat's jid/name and incoming/outgoing based on which side
 *   of the bubble it renders on
 * - a way to look up a chat by jid/display name (search box) and focus it
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
    async dumpHistory() {
      console.warn("[mudbot-v2.0] WhatsAppAdapter.dumpHistory() not implemented yet");
      return [];
    },
  };
}
