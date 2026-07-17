import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp();

/**
 * This server holds NO WhatsApp credentials or session state. It only ever
 * writes a pending command doc; the browser extension (which alone holds the
 * live authenticated WhatsApp Web session, on the user's own machine/IP) is
 * what actually performs the send. This is the entire point of the
 * extension-bridge split described in the plan: no WhatsApp protocol traffic
 * ever originates from server infrastructure, so there's no server-side
 * credential-custody burden and no "traffic from an unfamiliar location" risk.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "whatsapp-bridge", version: "0.1.0" });

  server.registerTool(
    "send_whatsapp_message",
    {
      description:
        "Send a WhatsApp message as the user, via their linked browser extension. " +
        "Async: queues the send and returns immediately; the extension executes it " +
        "after the user confirms (or auto-sends, once this pattern is trusted).",
      inputSchema: {
        uid: z.string(),
        patternId: z.string().optional(),
        target: z.object({ jid: z.string(), displayName: z.string() }),
        text: z.string(),
      },
    },
    async ({ uid, patternId, target, text }) => {
      const ref = await getFirestore().collection(`users/${uid}/commands`).add({
        type: "send_whatsapp_message",
        target,
        text,
        patternId,
        status: "pending",
        createdAt: new Date(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ commandId: ref.id, status: "queued" }) }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = process.env.PORT ?? 4002;
app.listen(port, () => console.log(`mcp-whatsapp-server listening on ${port}`));
