import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CloudSchedulerClient } from "@google-cloud/scheduler";

const scheduler = new CloudSchedulerClient();
const PROJECT = process.env.GCP_PROJECT!;
const LOCATION = process.env.SCHEDULER_LOCATION ?? "us-central1";
const INSTRUCT_URL = process.env.INSTRUCT_FUNCTION_URL!; // the deployed /instruct endpoint

/**
 * `schedule_task` doesn't invent its own reminder subsystem — it creates a
 * Cloud Scheduler job whose payload is a stored *synthetic instruction* that
 * gets POSTed back to /instruct when it fires, replaying it through the exact
 * same synthesize -> determine-action -> execute loop as any live message.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "scheduler", version: "0.1.0" });

  server.registerTool(
    "schedule_task",
    {
      description: "Schedule a synthetic instruction to run once at a future time (e.g. reminders).",
      inputSchema: {
        uid: z.string(),
        runAtIso: z.string().describe("ISO 8601 timestamp for when this should fire"),
        instructionText: z.string().describe("The instruction to replay through /instruct at that time"),
      },
    },
    async ({ uid, runAtIso, instructionText }) => {
      const jobId = `synthetic-${uid}-${Date.now()}`;
      const parent = scheduler.locationPath(PROJECT, LOCATION);

      await scheduler.createJob({
        parent,
        job: {
          name: `${parent}/jobs/${jobId}`,
          httpTarget: {
            uri: INSTRUCT_URL,
            httpMethod: "POST",
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify({ uid, rawText: instructionText })).toString("base64"),
          },
          // One-shot: Cloud Scheduler requires a cron schedule, so this uses a
          // schedule that fires once shortly after runAtIso and should be
          // deleted by a follow-up cleanup job once it has fired — a proper
          // one-shot mechanism (e.g. Cloud Tasks with a scheduled time) is a
          // more natural fit than repurposing Scheduler and is a follow-up.
          schedule: isoToOneShotCron(runAtIso),
          timeZone: "UTC",
        },
      });

      return { content: [{ type: "text", text: JSON.stringify({ jobId, scheduledFor: runAtIso }) }] };
    }
  );

  return server;
}

function isoToOneShotCron(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
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

const port = process.env.PORT ?? 4003;
app.listen(port, () => console.log(`mcp-scheduler-server listening on ${port}`));
