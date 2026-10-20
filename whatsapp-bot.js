import { createHash } from "node:crypto";
import { authenticateUser, getFirestoreDoc, patchFirestoreDoc } from "./firestore-client.js";
import { executeJotifiTool } from "./core.js";

const processedMessageIds = new Set();
const phoneTokenMemory = new Map(); // phone -> jtf_token
const chatHistoryMemory = new Map(); // phone -> Array of Gemini contents (last 8 turns)

function hashPhoneNumber(phone) {
  const clean = String(phone).replace(/\D/g, "");
  return createHash("sha256").update(`jotifi_wa_${clean}_v1`).digest("hex");
}

/**
 * Obtiene el token de JotiFi vinculado a un número de WhatsApp (desde memoria, Firestore o variable de entorno)
 */
async function getLinkedTokenForPhone(phone) {
  const cleanPhone = String(phone).replace(/\D/g, "");
  if (phoneTokenMemory.has(cleanPhone)) {
    return phoneTokenMemory.get(cleanPhone);
  }

  try {
    const hash = hashPhoneNumber(cleanPhone);
    const snap = await getFirestoreDoc(`whatsappLinks/${hash}`);
    if (snap.exists && snap.data?.token) {
      phoneTokenMemory.set(cleanPhone, snap.data.token);
      return snap.data.token;
    }
  } catch (err) {
    console.warn("No se pudo consultar whatsappLinks:", err.message);
  }

  return process.env.DEFAULT_JOTIFI_TOKEN || process.env.JOTIFI_TOKEN || null;
}

/**
 * Guarda el vínculo entre el número de WhatsApp y el token JotiFi del usuario
 */
async function saveLinkedTokenForPhone(phone, rawToken) {
  const cleanPhone = String(phone).replace(/\D/g, "");
  const cleanToken = rawToken.trim();
  const { idToken, uid } = await authenticateUser(cleanToken);

  phoneTokenMemory.set(cleanPhone, cleanToken);
  const hash = hashPhoneNumber(cleanPhone);

  await patchFirestoreDoc(
    `whatsappLinks/${hash}`,
    {
      token: cleanToken,
      uid,
      updatedAt: new Date().toISOString()
    },
    idToken
  );

  return { uid };
}

/**
 * Envía un mensaje de texto por WhatsApp Cloud API (Meta)
 */
async function sendWhatsAppMessage(phoneNumberId, to, text) {
  const waToken = process.env.WHATSAPP_TOKEN;
  if (!waToken) {
    console.error("Falta WHATSAPP_TOKEN en variables de entorno");
    return;
  }

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${waToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Error enviando WhatsApp:", res.status, errText);
  }
}

/**
 * Descarga un archivo multimedia (audio o imagen) desde WhatsApp Cloud API y lo convierte a base64
 */
async function downloadWhatsAppMedia(mediaId) {
  const waToken = process.env.WHATSAPP_TOKEN;
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` }
  });
  if (!metaRes.ok) {
    throw new Error(`No se pudo obtener info del media ${mediaId}`);
  }
  const metaJson = await metaRes.json();
  const mediaRes = await fetch(metaJson.url, {
    headers: { Authorization: `Bearer ${waToken}` }
  });
  if (!mediaRes.ok) {
    throw new Error(`No se pudo descargar el archivo multimedia de WhatsApp`);
  }
  const arrayBuffer = await mediaRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mimeType = (metaJson.mime_type || "application/octet-stream").split(";")[0].trim();
  return { base64, mimeType };
}

/**
 * Declaración de herramientas de JotiFi para Gemini Function Calling
 */
const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "jotifi_resumen_financiero",
        description:
          "Obtiene el resumen financiero completo del usuario en JotiFi: ingresos mensuales, bolsillos y sus gastos (pagados/pendientes), deudas globales, gastos compartidos y préstamos.",
        parameters: {
          type: "OBJECT",
          properties: {
            month: {
              type: "STRING",
              description: "Mes a consultar en formato YYYY-MM (opcional, por defecto el mes actual)"
            }
          }
        }
      },
      {
        name: "jotifi_crear_bolsillo",
        description: "Crea un nuevo bolsillo (sección de presupuesto) en JotiFi.",
        parameters: {
          type: "OBJECT",
          properties: {
            titulo: { type: "STRING", description: "Nombre del bolsillo" },
            ingreso: { type: "NUMBER", description: "Monto de ingreso asignado a este bolsillo" },
            month: { type: "STRING", description: "Mes en formato YYYY-MM (opcional)" }
          },
          required: ["titulo", "ingreso"]
        }
      },
      {
        name: "jotifi_agregar_gasto_bolsillo",
        description: "Agrega un gasto planeado o realizado dentro de un bolsillo de JotiFi.",
        parameters: {
          type: "OBJECT",
          properties: {
            bolsillo: { type: "STRING", description: "Nombre o ID del bolsillo donde se agregará el gasto" },
            nombreGasto: { type: "STRING", description: "Nombre o descripción del gasto" },
            monto: { type: "NUMBER", description: "Valor numérico del gasto" },
            diaVencimiento: { type: "STRING", description: "Día del mes (1 al 31) opcional" },
            pagado: { type: "BOOLEAN", description: "true si ya está pagado, false si está pendiente" }
          },
          required: ["bolsillo", "nombreGasto", "monto"]
        }
      },
      {
        name: "jotifi_marcar_gasto_pagado",
        description: "Marca o desmarca un gasto de un bolsillo como pagado/liquidado en JotiFi.",
        parameters: {
          type: "OBJECT",
          properties: {
            gasto: { type: "STRING", description: "Nombre o ID del gasto" },
            pagado: { type: "BOOLEAN", description: "true para pagado, false para pendiente" }
          },
          required: ["gasto"]
        }
      },
      {
        name: "jotifi_agregar_deuda",
        description: "Registra una nueva deuda en la sección Deudas de JotiFi.",
        parameters: {
          type: "OBJECT",
          properties: {
            nombre: { type: "STRING", description: "Nombre del acreedor o deuda" },
            montoTotal: { type: "NUMBER", description: "Monto total de la deuda" },
            cuotaMensual: { type: "NUMBER", description: "Valor de la cuota mensual" },
            totalCuotas: { type: "NUMBER", description: "Número total de cuotas" },
            diaPago: { type: "NUMBER", description: "Día del mes límite de pago (1 al 31)" }
          },
          required: ["nombre", "montoTotal", "cuotaMensual"]
        }
      },
      {
        name: "jotifi_abonar_deuda",
        description: "Registra el pago de una cuota mensual o un abono extra a capital en una deuda.",
        parameters: {
          type: "OBJECT",
          properties: {
            deuda: { type: "STRING", description: "Nombre o ID de la deuda" },
            montoAbono: { type: "NUMBER", description: "Monto a abonar (opcional)" },
            esCuotaMensual: { type: "BOOLEAN", description: "true si suma una cuota, false si es abono a capital" }
          },
          required: ["deuda"]
        }
      },
      {
        name: "jotifi_agregar_gasto_compartido",
        description: "Registra un nuevo gasto compartido en el grupo activo del usuario.",
        parameters: {
          type: "OBJECT",
          properties: {
            descripcion: { type: "STRING", description: "Descripción del gasto compartido" },
            monto: { type: "NUMBER", description: "Valor total del gasto compartido" },
            pagadoPor: { type: "STRING", description: "Nombre de quien pagó" },
            categoria: { type: "STRING", description: "Categoría opcional" }
          },
          required: ["descripcion", "monto", "pagadoPor"]
        }
      }
    ]
  }
];

/**
 * Procesa el mensaje del usuario con Gemini 2.5 Flash y ejecuta las herramientas de JotiFi necesarias
 */
async function runGeminiWhatsAppAgent(phone, userParts, jotifiToken) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!geminiKey) {
    return "⚠️ Falta configurar la variable `GEMINI_API_KEY` en Render para activar el cerebro de IA.";
  }

  const history = chatHistoryMemory.get(phone) || [];
  const contents = [
    ...history,
    { role: "user", parts: userParts }
  ];

  const systemInstruction = {
    parts: [
      {
        text: `Eres el Asistente Financiero Oficial de JotiFi en WhatsApp.
Tu objetivo es ayudar al usuario a consultar su resumen financiero, bolsillos, gastos, deudas y gastos compartidos, así como registrar pagos o nuevos gastos por texto, nota de voz o foto de recibo.
Reglas de estilo para WhatsApp:
- Sé conciso, cálido y directo.
- Usa formato de WhatsApp: *negrita* con un solo asterisco (no uses doble asterisco **) y viñetas claras con emojis.
- Antes de responder sobre saldos o si necesitas saber qué bolsillos existen para agregar un gasto, llama primero a jotifi_resumen_financiero.
- Si el usuario envía una foto de una factura/transferencia o un audio diciendo que compró o pagó algo, identifica el monto y concepto y regístralo o infórmalo claramente.`
      }
    ]
  };

  for (let step = 0; step < 4; step++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction,
          contents,
          tools: GEMINI_TOOLS
        })
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Error de Gemini API (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const modelContent = data.candidates?.[0]?.content;
    if (!modelContent || !Array.isArray(modelContent.parts)) {
      return "No pude procesar tu solicitud en este momento. Intenta de nuevo.";
    }

    contents.push(modelContent);

    const functionCalls = modelContent.parts.filter(p => p.functionCall);
    if (functionCalls.length === 0) {
      const replyText = modelContent.parts
        .map(p => p.text || "")
        .join("\n")
        .trim();

      // Guardar últimos turnos de texto en memoria
      const updatedHistory = contents.slice(-6).filter(c =>
        c.parts.every(p => p.text && !p.inlineData)
      );
      chatHistoryMemory.set(phone, updatedHistory);

      return replyText || "✅ Listo, operación realizada en JotiFi.";
    }

    // Ejecutar las llamadas a herramientas solicitadas por Gemini
    const responseParts = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      let toolResult;
      try {
        toolResult = await executeJotifiTool(name, args || {}, jotifiToken);
      } catch (toolErr) {
        toolResult = `Error ejecutando ${name}: ${toolErr.message}`;
      }
      responseParts.push({
        functionResponse: {
          name,
          response: { result: toolResult }
        }
      });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return "✅ Tus datos en JotiFi fueron actualizados.";
}

/**
 * Registra los endpoints del Webhook de WhatsApp en Express
 */
export function registerWhatsAppRoutes(app) {
  // 1. Verificación del Webhook con Meta (GET /webhook/whatsapp)
  app.get("/webhook/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || "jotifi_verify_2026";

    if (mode === "subscribe" && token === expectedToken) {
      console.log("✅ Webhook de WhatsApp verificado por Meta");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Token de verificación inválido");
  });

  // 2. Recepción de mensajes de WhatsApp (POST /webhook/whatsapp)
  app.post("/webhook/whatsapp", (req, res) => {
    // Responder 200 de inmediato a Meta para evitar reintentos
    res.status(200).send("EVENT_RECEIVED");

    (async () => {
      try {
        const entry = req.body?.entry?.[0];
        const changes = entry?.changes?.[0]?.value;
        const message = changes?.messages?.[0];
        const phoneNumberId = changes?.metadata?.phone_number_id;

        if (!message || !phoneNumberId) return;

        // Evitar duplicados
        if (processedMessageIds.has(message.id)) return;
        processedMessageIds.add(message.id);
        if (processedMessageIds.size > 500) {
          const firstKey = processedMessageIds.values().next().value;
          processedMessageIds.delete(firstKey);
        }

        const from = message.from;
        const textBody = message.text?.body?.trim() || "";

        // A) Comando de vinculación: /conectar jtf_... o envío directo del token jtf_...
        const tokenMatch = textBody.match(/(jtf_[A-Za-z0-9_-]+)/);
        if (tokenMatch) {
          try {
            await saveLinkedTokenForPhone(from, tokenMatch[1]);
            await sendWhatsAppMessage(
              phoneNumberId,
              from,
              "✅ *¡Tu cuenta de JotiFi quedó vinculada a tu WhatsApp!*\n\nYa puedes preguntarme o enviarme notas de voz y fotos de recibos, por ejemplo:\n• _¿Cuánto me queda libre este mes?_\n• _Agrega un gasto de 35.000 de Uber en Transporte_\n• _Ya pagué el recibo de internet_"
            );
          } catch (linkErr) {
            await sendWhatsAppMessage(
              phoneNumberId,
              from,
              `❌ No pude vincular tu token de JotiFi: ${linkErr.message}\n\nEntra a *JotiFi > Ajustes > Conector Gemini (MCP)* y copia un token nuevo.`
            );
          }
          return;
        }

        // B) Verificar que el usuario tenga su cuenta vinculada
        const jotifiToken = await getLinkedTokenForPhone(from);
        if (!jotifiToken) {
          await sendWhatsAppMessage(
            phoneNumberId,
            from,
            "👋 ¡Hola! Soy el *Asistente de JotiFi*.\n\nPara vincular tu cuenta por única vez:\n1. Entra a *https://jotifi-f1c7f.web.app*\n2. Ve a *Ajustes > Conector Gemini y WhatsApp*\n3. Toca *Copiar Comando para WhatsApp* y pégalo en este chat."
          );
          return;
        }

        // C) Construir partes del mensaje (Texto, Nota de Voz o Imagen de recibo)
        const userParts = [];

        if (message.type === "text" && textBody) {
          userParts.push({ text: textBody });
        } else if (message.type === "audio" && message.audio?.id) {
          const { base64, mimeType } = await downloadWhatsAppMedia(message.audio.id);
          userParts.push(
            { inlineData: { mimeType, data: base64 } },
            { text: "Escucha esta nota de voz del usuario y ejecuta o responde su solicitud financiera en JotiFi." }
          );
        } else if (message.type === "image" && message.image?.id) {
          const { base64, mimeType } = await downloadWhatsAppMedia(message.image.id);
          const caption = message.image.caption || "Analiza este recibo o comprobante y ayúdame a registrarlo en JotiFi.";
          userParts.push(
            { inlineData: { mimeType, data: base64 } },
            { text: caption }
          );
        } else {
          await sendWhatsAppMessage(
            phoneNumberId,
            from,
            "Por ahora puedo leer *mensajes de texto*, *notas de voz* 🎙️ y *fotos de recibos/facturas* 📸."
          );
          return;
        }

        const aiReply = await runGeminiWhatsAppAgent(from, userParts, jotifiToken);
        await sendWhatsAppMessage(phoneNumberId, from, aiReply);
      } catch (err) {
        console.error("Error procesando mensaje de WhatsApp:", err);
      }
    })();
  });
}
