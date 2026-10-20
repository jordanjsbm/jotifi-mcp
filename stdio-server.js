import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJotifiMcpServer } from "./core.js";

async function main() {
  const token = process.env.JOTIFI_TOKEN || process.argv[2] || "";
  const server = createJotifiMcpServer(() => token);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error in JotiFi Stdio MCP Server:", err);
  process.exit(1);
});
