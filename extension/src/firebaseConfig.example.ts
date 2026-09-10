// Copy this file to firebaseConfig.ts and fill in real values from the Firebase
// console (Project settings -> General -> Your apps). firebaseConfig.ts is
// gitignored — it's where your actual project's values live, kept out of the
// public repo. (These values aren't secret — Firebase web config is meant to be
// public, protected by security rules/App Check rather than secrecy — this is
// just about not tying a specific project id to the public repo.)
export const firebaseConfig = {
  apiKey: "TODO",
  authDomain: "TODO.firebaseapp.com",
  projectId: "TODO",
  // Realtime Database's regions are a much smaller set than Firestore's, so
  // this is very likely NOT the default https://TODO-default-rtdb.firebaseio.com
  // form — copy the real URL from Firebase console → Realtime Database.
  databaseURL: "TODO",
};
