import type { Request } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";

export class UnauthorizedError extends Error {}

/** Every request comes from the extension with a Firebase ID token (phone-auth
 * login). uid is the tenant key for every Firestore path in this codebase. */
export async function requireUid(req: Request): Promise<string> {
  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new UnauthorizedError("missing bearer token");

  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    return decoded.uid;
  } catch (err) {
    // Without this, a bad/expired token and a genuine server error both come
    // back as an opaque 500 to the client — indistinguishable without digging
    // through function logs. Surfacing the real reason as a 401 makes token
    // problems self-diagnosing from the browser console alone.
    throw new UnauthorizedError(`invalid ID token: ${(err as Error).message}`);
  }
}
