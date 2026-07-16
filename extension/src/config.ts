// TODO: point these at your deployed Cloud Functions / Cloud Run URLs.
export const API_BASE_URL = "https://us-central1-mudbot-v2.cloudfunctions.net";

export type SessionRole = "numberA" | "numberB";

export async function getRoleForTab(tabId: number): Promise<SessionRole | null> {
  const key = `role:${tabId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

export async function getTabForRole(role: SessionRole): Promise<number | null> {
  const key = `tabForRole:${role}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

/** Set once per tab from the popup, while that WhatsApp Web tab is open and
 * focused — sidesteps needing to parse WhatsApp's own multi-account URL scheme. */
export async function setRoleForTab(tabId: number, role: SessionRole): Promise<void> {
  await chrome.storage.local.set({
    [`role:${tabId}`]: role,
    [`tabForRole:${role}`]: tabId,
  });
}
