import { ref, update } from "firebase/database";
import { rtdb } from "./firebaseClient";

/** Writes onto the same commands/{uid}/{commandId} node the query arrived
 * on — the web chat page is listening there for exactly this update. */
export async function replyToCommand(uid: string, commandId: string, text: string): Promise<void> {
  await update(ref(rtdb, `commands/${uid}/${commandId}`), { reply: text, repliedAt: Date.now() });
}
