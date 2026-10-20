# Servidor MCP Multiusuario de JotiFi 🚀

Este directorio contiene el servidor **Model Context Protocol (MCP)** oficial de **JotiFi**, diseñado para que cualquier usuario de la app pueda conectar su propia cuenta de JotiFi con **Gemini** (en Conectores Web, Gemini CLI, Antigravity o Claude) sin afectar ni exponer datos de otros usuarios.

---

## 🔒 ¿Cómo funciona la seguridad multiusuario?
1. Cada usuario inicia sesión normalmente en JotiFi y entra a **Ajustes > Conector Gemini (MCP)**.
2. Al pulsar **Copiar URL Personal para Gemini**, JotiFi genera un token personal (`jtf_...`) basado en su sesión autenticada de Firebase.
3. Cuando Gemini invoca una herramienta del servidor MCP, el servidor intercambia ese token con **Firebase Auth (`securetoken.googleapis.com`)** por un `idToken` oficial de corta duración y consulta Firestore respetando el 100% de tus reglas en [`firestore.rules`](../firestore.rules) (`request.auth.uid == userId`).

---

## 🛠️ Herramientas incluidas en el MCP
- `jotifi_resumen_financiero`: Consulta ingresos, gastos planeados, dinero libre, bolsillos del mes, deudas globales, gastos compartidos y préstamos.
- `jotifi_crear_bolsillo`: Crea un nuevo bolsillo de presupuesto en el mes actual o especificado.
- `jotifi_agregar_gasto_bolsillo`: Agrega un gasto planeado a un bolsillo existente.
- `jotifi_marcar_gasto_pagado`: Marca o desmarca un gasto de bolsillo como pagado/liquidado.
- `jotifi_agregar_deuda`: Registra una nueva deuda en la sección Deudas.
- `jotifi_abonar_deuda`: Registra el pago de una cuota fija o abono extra a capital en una deuda.
- `jotifi_agregar_gasto_compartido`: Registra un gasto compartido en el grupo activo del usuario.

---

## ▶️ Cómo ejecutarlo

### 1. Modo Servidor Remoto (Streamable HTTP + SSE para todos los usuarios)
```bash
cd mcp-server
npm install
npm start
```
El servidor quedará activo en `http://localhost:3001`:
- **Endpoint Streamable HTTP**: `http://localhost:3001/mcp?token=jtf_...`
- **Endpoint SSE**: `http://localhost:3001/sse?token=jtf_...`

> **Despliegue en la nube (Render / Railway / Google Cloud Run)**:
> Sube la carpeta `mcp-server` (o configura el Root Directory como `mcp-server`), con comando de inicio `npm start`. Luego coloca la URL pública en la variable `VITE_MCP_SERVER_URL` de tu `.env` o directamente en la caja **URL Base del Servidor MCP** dentro de **Ajustes** en JotiFi.

### 2. Modo Local (`stdio`)
Si deseas conectarlo por `stdio` en tu equipo:
```json
{
  "mcpServers": {
    "jotifi": {
      "command": "node",
      "args": ["d:/JSBM/2026/joti-fi-app/mcp-server/stdio-server.js"],
      "env": {
        "JOTIFI_TOKEN": "jtf_TU_TOKEN_PERSONAL"
      }
    }
  }
}
```
