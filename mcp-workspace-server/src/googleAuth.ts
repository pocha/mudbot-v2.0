import { getFirestore } from "firebase-admin/firestore";
import { google } from "googleapis";

/**
 * Placeholder token lookup: resolves the per-user Google OAuth refresh token
 * (via the Secret Manager pointer stored on users/{uid}.googleOAuthTokenRef,
 * per the plan) and returns an authenticated client. Real Secret Manager
 * fetch + token refresh handling is a follow-up — this stub is here so the
 * tool handlers below have a single seam to fill in rather than reaching into
 * Firestore directly.
 */
export async function getGoogleClientForUser(uid: string) {
  const user = (await getFirestore().doc(`users/${uid}`).get()).data();
  if (!user?.googleOAuthTokenRef) {
    throw new Error(`user ${uid} has not connected Google Workspace yet`);
  }
  // TODO: fetch the refresh token from Secret Manager using user.googleOAuthTokenRef,
  // then build an OAuth2 client and set credentials before returning.
  const auth = new google.auth.OAuth2();
  return auth;
}
