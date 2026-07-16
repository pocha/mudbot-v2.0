// Mirrors functions/src/types/domain.ts's CommandDoc — duplicated rather than
// shared across packages since the extension bundles for the browser and the
// functions package targets Node; keep the two in sync by hand if this shape changes.
export interface CommandDoc {
  type: "send_whatsapp_message";
  executeAs: "numberA" | "numberB";
  target: { jid: string; displayName: string };
  text: string;
  status: "pending" | "confirmed" | "sent" | "rejected";
  patternId?: string;
}
