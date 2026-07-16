import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { initializeApp } from "firebase-admin/app";
import { google } from "googleapis";
import { getGoogleClientForUser } from "./googleAuth";

initializeApp();

/** Synchronous tools: unlike the WhatsApp bridge, these call the real Google
 * APIs directly and return a result immediately — no human confirmation loop
 * baked into the tool itself (that's handled upstream by pattern-stage policy
 * before this tool is ever called). */
function buildServer(): McpServer {
  const server = new McpServer({ name: "workspace", version: "0.1.0" });

  server.registerTool(
    "sheet_update",
    {
      description: "Append a row to a Google Sheet. Use resourceId from a resolved resourceBinding, not a guessed name.",
      inputSchema: {
        uid: z.string(),
        patternId: z.string().optional(),
        spreadsheetId: z.string(),
        sheetName: z.string().default("Sheet1"),
        row: z.array(z.string()),
      },
    },
    async ({ uid, spreadsheetId, sheetName, row }) => {
      const auth = await getGoogleClientForUser(uid);
      const sheets = google.sheets({ version: "v4", auth });
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      return { content: [{ type: "text", text: JSON.stringify({ updatedRange: result.data.updates?.updatedRange }) }] };
    }
  );

  server.registerTool(
    "calendar_event",
    {
      description: "Create a Google Calendar event.",
      inputSchema: {
        uid: z.string(),
        patternId: z.string().optional(),
        calendarId: z.string().default("primary"),
        summary: z.string(),
        startIso: z.string(),
        endIso: z.string(),
      },
    },
    async ({ uid, calendarId, summary, startIso, endIso }) => {
      const auth = await getGoogleClientForUser(uid);
      const calendar = google.calendar({ version: "v3", auth });
      const result = await calendar.events.insert({
        calendarId,
        requestBody: {
          summary,
          start: { dateTime: startIso },
          end: { dateTime: endIso },
        },
      });
      return { content: [{ type: "text", text: JSON.stringify({ eventId: result.data.id }) }] };
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

const port = process.env.PORT ?? 4001;
app.listen(port, () => console.log(`mcp-workspace-server listening on ${port}`));
