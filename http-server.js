import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createJotifiMcpServer } from "./core.js";

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Extrae el token personal del usuario desde la URL (?token=jtf_...) o header Authorization
 */
function extractUserToken(req) {
  if (req.query?.token) return String(req.query.token);
  const authHeader = req.headers["authorization"] || req.headers["x-jotifi-token"];
  if (authHeader) return String(authHeader).replace(/^Bearer\s+/i, "");
  return process.env.JOTIFI_TOKEN || "";
}

// Almacenamiento de sesiones activas (Streamable HTTP y SSE)
const httpTransports = new Map();
const sseTransports = new Map();

// Endpoint informativo / Healthcheck
app.get("/", (_req, res) => {
  res.json({
    service: "JotiFi MCP Server (Multiusuario)",
    status: "online",
    endpoints: {
      streamableHttp: "/mcp?token=TU_TOKEN_JOTIFI",
      sse: "/sse?token=TU_TOKEN_JOTIFI"
    },
    instructions: "Obtén tu URL y Token personal en JotiFi > Ajustes > Conector Gemini (MCP)"
  });
});

// ============================================================================
// 1. STREAMABLE HTTP TRANSPORT (/mcp) — Estándar moderno para Conectores Web
// ============================================================================
app.all("/mcp", async (req, res) => {
  try {
    const userToken = extractUserToken(req);
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && httpTransports.has(sessionId)) {
      const entry = httpTransports.get(sessionId);
      if (userToken) entry.token = userToken;
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    // Crear nueva sesión o manejo stateless por petición
    const state = { token: userToken };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        httpTransports.set(newSessionId, { transport, state });
      }
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        httpTransports.delete(transport.sessionId);
      }
    };

    const mcpServer = createJotifiMcpServer(() => state.token);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error en /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Error interno en JotiFi MCP" });
    }
  }
});

// ============================================================================
// 2. SSE TRANSPORT (/sse + /messages) — Compatibilidad con clientes SSE
// ============================================================================
app.get("/sse", async (req, res) => {
  try {
    const userToken = extractUserToken(req);
    const state = { token: userToken };
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, { transport, state });

    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
    });

    const mcpServer = createJotifiMcpServer(() => state.token);
    await mcpServer.connect(transport);
  } catch (err) {
    console.error("Error en /sse:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post("/messages", async (req, res) => {
  try {
    const sessionId = req.query?.sessionId;
    const entry = sseTransports.get(sessionId);
    if (!entry) {
      res.status(404).json({ error: "Sesión SSE no encontrada" });
      return;
    }
    const tokenFromReq = extractUserToken(req);
    if (tokenFromReq) entry.state.token = tokenFromReq;
    await entry.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error("Error en /messages:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor MCP Multiusuario de JotiFi activo en http://localhost:${PORT}`);
  console.log(`🔗 Conector Streamable HTTP: http://localhost:${PORT}/mcp?token=TU_TOKEN_JOTIFI`);
  console.log(`🔗 Conector SSE:             http://localhost:${PORT}/sse?token=TU_TOKEN_JOTIFI`);
});
