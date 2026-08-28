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
/** One entry in a conversation dump — same shape ingestCore/train-from-dump.ts
 * expect, so a dump can be replayed without any reshaping. Built from
 * Store-based data now (see content-script.ts's toDumpedMessage), not by this
 * file — kept here since it's still the shared type both sides import. */
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

export interface WhatsAppAdapter {
  /** Open (or focus) the chat for a given jid (i.e. display name — see the
   * file-level note above), type `text` into the composer, and send it — used
   * both for real actions and for assistant-chat notifications. */
  sendMessage(jid: string, text: string): Promise<void>;
}

// ---- Chat list (confirmed against a live DOM dump) ----

function queryChatRows(): HTMLElement[] {
  const container = document.querySelector('div[aria-label="Chat list"][role="grid"]');
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('div[role="row"][data-testid^="list-item-"]'));
}

/**
 * Pulls a chat-list row's display name and last-message timestamp text — used
 * by openChatByName below to find/click the right row by name (display name
 * is still what sendMessage's jid parameter means, per the file-level note;
 * chat listing/dumping itself now goes through Store-based real jids instead,
 * see content-script.ts).
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

// ---- Adapter ----
// Passive observation (DOM MutationObserver), chat listing, and history
// dumping used to live here too, but are now handled via inject.ts's
// Store-based access instead (see content-script.ts) — more reliable (global
// across all chats, not just the one open on screen) and gives real jids
// instead of display-name stand-ins. sendMessage has no Store-based
// replacement yet, so it's the only thing still implemented via DOM
// automation.

export function createWhatsAppAdapter(): WhatsAppAdapter {
  return {
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
  };
}
