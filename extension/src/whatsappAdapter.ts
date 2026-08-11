/**
 * Everything WhatsApp-Web-DOM-specific lives behind this interface. web.whatsapp.com's
 * DOM is unofficial, obfuscated, and changes without notice — rather than guess at
 * selectors here, this is a seam to fill in after inspecting the live page in devtools.
 * Keeping it isolated means a DOM change only requires editing this one file.
 *
 * A note on "jid": that name is inherited from the rest of the codebase (which
 * expected a real WhatsApp jid, e.g. "919876543210@s.whatsapp.net"), but this
 * version of WhatsApp Web's DOM doesn't expose one anywhere — not on chat-list
 * rows, not on individual message elements (confirmed by inspecting both live).
 * Older WhatsApp Web builds used to carry it in a data-id attribute; this
 * rewritten version's data-id on message elements is just an opaque message id,
 * unrelated to the chat. Rather than reach into WhatsApp Web's internal
 * webpack/Store modules to recover a real one (the technique mature WhatsApp
 * automation libraries use, but fragile against WhatsApp's own internal
 * refactors and real added complexity), the deliberate choice here is to use
 * the chat's **display name** as its identity everywhere "jid" appears in this
 * file and the types built on it (MemoryDoc.sourceJid, ContactDoc/GroupDoc.jid,
 * CommandDoc.target.jid, etc.). Nothing downstream parses these as real WhatsApp
 * ids — they're treated as opaque tenant-scoped strings throughout — so this is
 * a values-only decision, not a type/schema change. Known tradeoff: two chats
 * saved under the exact same name are indistinguishable; the server's
 * resolve/entities.ts already asks a clarifying question on an ambiguous name
 * match, so this degrades to "ask the user" rather than silently picking wrong.
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

  /** Open (or focus) the chat for a given jid (i.e. display name — see the
   * file-level note above), type `text` into the composer, and send it — used
   * both for real actions and for assistant-chat notifications. */
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

  /** Identity of WhatsApp's own "Message Yourself" self-chat for the logged-in
   * account (its display name, per the file-level note above) — the recommended
   * default assistant channel, so the owner doesn't need a second phone
   * number/WhatsApp account just to talk to the assistant. */
  getSelfJid(): Promise<string | null>;
}

// ---- Chat list (confirmed against a live DOM dump) ----

function queryChatRows(): HTMLElement[] {
  const container = document.querySelector('div[aria-label="Chat list"][role="grid"]');
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('div[role="row"][data-testid^="list-item-"]'));
}

/**
 * Pulls a chat-list row's display name (used as its jid, see file-level note)
 * and last-message timestamp text. A (2), (3)... suffix is added on name
 * collision so picker keys stay unique within one listRecentChats() call.
 */
function extractChatSummary(row: HTMLElement): { displayName: string; lastMessageAt: string } {
  const nameEl = row.querySelector<HTMLElement>('[data-testid="cell-frame-title"] span[title]');
  const displayName = nameEl?.getAttribute("title")?.trim() || nameEl?.textContent?.trim() || "";

  const timeEl = row.querySelector<HTMLElement>('[data-testid="cell-frame-primary-detail"] span');
  const lastMessageAt = timeEl?.textContent?.trim() ?? "";

  return { displayName, lastMessageAt };
}

// ---- Small async helpers ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/** Fires a full pointerdown/mousedown/pointerup/mouseup/click sequence rather
 * than relying on el.click() (which only dispatches "click") or even just
 * mouse events — many modern React apps, especially virtualized lists, bind
 * interactions to Pointer Events rather than legacy mouse events, so a click
 * that only sends MouseEvents can be silently ignored. */
function dispatchClick(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const pointerOpts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, ...point };
  const mouseOpts = { bubbles: true, cancelable: true, view: window, button: 0, ...point };

  el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  el.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
  el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  el.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
  el.dispatchEvent(new MouseEvent("click", mouseOpts));
}

/**
 * The chat-list's outer grid element (aria-label="Chat list") is the
 * virtualized spacer sized to the *full* list height, not the scrollable
 * viewport itself. #pane-side (confirmed live) is the stable, semantic
 * container the whole sidebar lives in, so the actual scrollable element is
 * either #pane-side itself or one of its descendants — checked in that order
 * rather than guessing a specific nested selector, since exactly which one
 * has overflow-y set wasn't confirmed directly.
 */
function findChatListScrollContainer(): HTMLElement | null {
  const paneSide = document.querySelector<HTMLElement>("#pane-side");
  if (!paneSide) return null;

  const isScrollable = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
  };

  if (isScrollable(paneSide)) return paneSide;
  return Array.from(paneSide.querySelectorAll<HTMLElement>("*")).find(isScrollable) ?? null;
}

// ---- Opening a chat by name ----

function getOpenChatTitle(): string | null {
  const el = document.querySelector('[data-testid="conversation-info-header-chat-title"]');
  return el?.textContent?.trim() || null;
}

/**
 * The outer div[role="row"] is just a virtualization/layout wrapper — the
 * actual interactive element WhatsApp's click handler is bound to is the
 * descendant carrying aria-selected (confirmed present in a live row dump:
 * <div tabindex="-1" aria-selected="false">), one level in from
 * div[role="gridcell"]. Falling back to the gridcell, then the row itself, in
 * case that structure varies (e.g. community/group rows dumped earlier had a
 * slightly different nesting).
 */
function findChatRowClickTarget(row: HTMLElement): HTMLElement {
  return (
    row.querySelector<HTMLElement>("[aria-selected]") ??
    row.querySelector<HTMLElement>('[role="gridcell"]') ??
    row
  );
}

/**
 * Finds the chat-list row matching `name` and clicks it, scrolling the
 * (virtualized) chat list in steps if it's not among the currently-rendered
 * rows. Waits for the conversation header to reflect the newly opened chat
 * before resolving, since WhatsApp Web's panel swap isn't synchronous.
 */
async function openChatByName(name: string, maxScrollAttempts = 20): Promise<boolean> {
  const scrollTarget = findChatListScrollContainer();

  for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
    const match = queryChatRows().find((row) => extractChatSummary(row).displayName === name);
    if (match) {
      const clickTarget = findChatRowClickTarget(match);
      dispatchClick(clickTarget);
      const opened = await waitFor(() => getOpenChatTitle() === name, 5000);
      if (!opened) {
        console.warn(
          `[mudbot-v2.0] openChatByName("${name}"): clicked ${clickTarget.tagName.toLowerCase()}` +
            `${clickTarget.getAttribute("aria-selected") !== null ? "[aria-selected]" : ""}, but the header ` +
            `never updated to match within 5s (currently: "${getOpenChatTitle() ?? "(no chat open)"}")`
        );
      }
      return opened;
    }

    if (!scrollTarget) break;
    scrollTarget.scrollTop += scrollTarget.clientHeight;
    await sleep(300); // let virtualization render newly-scrolled-into-view rows
  }
  return false;
}

// ---- Message parsing (confirmed against live incoming + outgoing DOM dumps) ----

/** data-pre-plain-text is formatted like "[9:50 am, 9/6/2026] Sender Name: " —
 * confirmed D/M/YYYY (an example showed day 13, ruling out M/D). */
function parsePrePlainText(raw: string): { author: string; timestamp: string } | null {
  const match = raw.match(/^\[(\d{1,2}):(\d{2})\s*([ap]m),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]\s*(.*?):\s*$/i);
  if (!match) return null;
  const [, hh, mm, ap, day, month, year, author] = match;
  let hour = parseInt(hh, 10) % 12;
  if (ap.toLowerCase() === "pm") hour += 12;
  const date = new Date(Number(year), Number(month) - 1, Number(day), hour, Number(mm));
  return { author, timestamp: date.toISOString() };
}

/** A message you sent has an (empty, accessibility-only) `aria-label="You:"`
 * span — cleaner and more reliable than trying to infer direction from the
 * obfuscated tail-in/tail-out atomic CSS classes. */
function isOutgoingRow(row: HTMLElement): boolean {
  return !!row.querySelector('span[aria-label="You:"]');
}

function rowToDumpedMessage(row: HTMLElement, chatDisplayName: string): DumpedMessage | null {
  const text = row.querySelector<HTMLElement>('[data-testid="selectable-text"]')?.textContent?.trim();
  if (!text) return null; // media-only/system messages: skip for now, not text to ingest

  const outgoing = isOutgoingRow(row);
  const preplain = row.querySelector<HTMLElement>("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") ?? "";
  const parsed = parsePrePlainText(preplain);

  return {
    jid: chatDisplayName,
    displayName: outgoing ? "You" : parsed?.author ?? chatDisplayName,
    text,
    direction: outgoing ? "outgoing" : "incoming",
    timestamp: parsed?.timestamp ?? new Date().toISOString(),
  };
}

// ---- Adapter ----

export function createWhatsAppAdapter(): WhatsAppAdapter {
  return {
    observe(onMessage) {
      const root = document.querySelector("#main");
      if (!root) {
        console.warn("[mudbot-v2.0] WhatsAppAdapter.observe(): #main not found — open a chat first");
        return;
      }

      // Observing #main (not the messages container directly) so this survives
      // switching chats, since WhatsApp Web unmounts/remounts the messages
      // container itself on every chat switch. Re-scanning all currently
      // rendered rows on every mutation and deduping via a WeakSet is simpler
      // and more robust here than trying to precisely track addedNodes across
      // a virtualized, frequently-replaced subtree.
      const seen = new WeakSet<Element>();
      const observer = new MutationObserver(() => {
        const chatTitle = getOpenChatTitle();
        if (!chatTitle) return;
        for (const row of Array.from(document.querySelectorAll<HTMLElement>('div[data-testid^="conv-msg-"]'))) {
          if (seen.has(row)) continue;
          seen.add(row);
          const dumped = rowToDumpedMessage(row, chatTitle);
          if (dumped) {
            const { timestamp: _timestamp, ...msg } = dumped;
            onMessage(msg);
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    },

    async sendMessage(jid, _text) {
      const opened = await openChatByName(jid);
      if (!opened) {
        console.warn(`[mudbot-v2.0] WhatsAppAdapter.sendMessage(): could not find/open chat "${jid}"`);
        return;
      }
      // TODO: composer contenteditable + send-button selectors not confirmed
      // yet — need one more DOM inspection (compose a message, inspect the
      // input box and send button) to finish this.
      console.warn(`[mudbot-v2.0] WhatsAppAdapter.sendMessage(): opened "${jid}" but composer/send is not implemented yet`);
    },

    async listRecentChats(limit) {
      const seen = new Map<string, number>();
      const chats: ChatSummary[] = [];

      for (const row of queryChatRows().slice(0, limit)) {
        const { displayName, lastMessageAt } = extractChatSummary(row);
        if (!displayName) continue;

        const count = (seen.get(displayName) ?? 0) + 1;
        seen.set(displayName, count);
        const jid = count === 1 ? displayName : `${displayName} (${count})`;
        chats.push({ jid, displayName, lastMessageAt });
      }

      return chats;
    },

    async dumpHistory(jids) {
      const results: DumpedMessage[] = [];

      for (const jid of jids) {
        const opened = await openChatByName(jid);
        if (!opened) {
          console.warn(`[mudbot-v2.0] WhatsAppAdapter.dumpHistory(): could not open chat "${jid}", skipping`);
          continue;
        }

        // The header can update before the messages container actually mounts
        // — wait for it explicitly rather than assuming it's there the instant
        // openChatByName resolves.
        const containerReady = await waitFor(
          () => !!document.querySelector('[data-testid="conversation-panel-messages"]'),
          3000
        );
        const container = document.querySelector<HTMLElement>('[data-testid="conversation-panel-messages"]');
        if (!containerReady || !container) {
          console.warn(`[mudbot-v2.0] dumpHistory("${jid}"): chat opened but the messages panel never appeared, skipping`);
          continue;
        }

        // Scroll up to lazy-load history until: WhatsApp's own "message
        // history before X" boundary appears, growth stalls, or a sane cap is
        // hit (100 messages, matching what was discussed as a reasonable
        // default) — whichever comes first.
        const MAX_ROUNDS = 40;
        const MAX_MESSAGES = 100;
        let lastHeight = -1;
        let rounds = 0;
        for (; rounds < MAX_ROUNDS; rounds++) {
          if (container.textContent?.includes("Use WhatsApp on your phone")) break;
          if (container.querySelectorAll('div[data-testid^="conv-msg-"]').length >= MAX_MESSAGES) break;
          if (container.scrollHeight === lastHeight) break; // nothing new loaded last round
          lastHeight = container.scrollHeight;
          container.scrollTop = 0;
          await sleep(400); // let WhatsApp Web lazy-load the next batch
        }

        const chatTitle = getOpenChatTitle() ?? jid;
        const rows = Array.from(container.querySelectorAll<HTMLElement>('div[data-testid^="conv-msg-"]'));
        let extracted = 0;
        for (const row of rows) {
          const msg = rowToDumpedMessage(row, chatTitle);
          if (msg) {
            results.push(msg);
            extracted++;
          }
        }
        console.log(
          `[mudbot-v2.0] dumpHistory("${jid}"): scrolled ${rounds} round(s), found ${rows.length} message row(s), extracted ${extracted} with text`
        );
      }

      return results;
    },

    async getSelfJid() {
      console.warn("[mudbot-v2.0] WhatsAppAdapter.getSelfJid() not implemented yet");
      return null;
    },
  };
}
