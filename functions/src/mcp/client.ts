import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Talks to our own MCP servers directly via the official MCP TypeScript SDK,
 * rather than through genkitx-mcp's registry indirection — that plugin's
 * introspection API has moved across releases and wasn't worth pinning
 * against for this scaffold. describeAvailableTools()/callTool() are the only
 * two things the rest of the orchestrator needs, and both are stable,
 * documented Client methods here.
 *
 * toolName everywhere else in this codebase is "<server>/<tool>", e.g.
 * "workspace/sheet_update" — the prefix is how we route to the right server.
 */
const SERVER_URLS: Record<string, string | undefined> = {
  workspace: process.env.MCP_WORKSPACE_URL,
  whatsapp: process.env.MCP_WHATSAPP_URL,
  scheduler: process.env.MCP_SCHEDULER_URL,
};

const clients = new Map<string, Client>();

async function getClient(server: string): Promise<Client> {
  const cached = clients.get(server);
  if (cached) return cached;

  const url = SERVER_URLS[server];
  if (!url) throw new Error(`no server URL configured for MCP server "${server}"`);

  const client = new Client({ name: `mudbot-${server}-client`, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  await client.connect(transport);
  clients.set(server, client);
  return client;
}

/**
 * Formats the current tool manifest as text for the action-determination prompt.
 * If a server is down, its tools simply won't appear — the model then has no
 * choice but to fall back to `unsupported`, which is the desired behavior.
 */
export async function describeAvailableTools(): Promise<string> {
  const lines: string[] = [];
  for (const server of Object.keys(SERVER_URLS)) {
    try {
      const client = await getClient(server);
      const { tools } = await client.listTools();
      for (const t of tools) {
        lines.push(`- ${server}/${t.name}: ${t.description ?? "(no description)"}`);
      }
    } catch (err) {
      console.warn(`[mcp] could not reach "${server}": ${(err as Error).message}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no tools currently available)";
}

export async function callTool(toolName: string, input: Record<string, unknown>) {
  const [server, name] = toolName.split("/");
  if (!server || !name) throw new Error(`callTool: expected "server/tool", got "${toolName}"`);
  const client = await getClient(server);
  return client.callTool({ name, arguments: input });
}
