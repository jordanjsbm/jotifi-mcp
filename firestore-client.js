const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyCjxBK9PBtkZCP8OuVp2f188HQbR3Lthn0";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "jotifi-f1c7f";
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// Cache de sesiones en memoria (token -> { idToken, uid, expiresAt })
const tokenCache = new Map();

/**
 * Decodifica un token MCP de JotiFi (formato jtf_<base64url> o refreshToken directo)
 */
export function decodeJotifiToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") {
    throw new Error("No se proporcionó un token de JotiFi válido. Genéralo en JotiFi > Ajustes > Conector Gemini (MCP).");
  }
  const clean = rawToken.trim().replace(/^Bearer\s+/i, "");
  if (clean.startsWith("jtf_")) {
    try {
      const payload = Buffer.from(clean.slice(4), "base64url").toString("utf8");
      const parsed = JSON.parse(payload);
      if (parsed.rt) return parsed.rt;
    } catch {
      // Si no es JSON base64url, intentar usar el resto directamente
      return clean.slice(4);
    }
  }
  return clean;
}

/**
 * Intercambia el refreshToken de Firebase del usuario por un idToken válido y su UID.
 * Respeta 100% las reglas de seguridad de Firestore (request.auth.uid == userId).
 */
export async function authenticateUser(mcpToken) {
  const refreshToken = decodeJotifiToken(mcpToken);
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached;
  }

  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token de JotiFi inválido o expirado. Por favor genera uno nuevo en JotiFi > Ajustes. (${res.status}: ${errText})`);
  }

  const data = await res.json();
  const session = {
    idToken: data.id_token,
    uid: data.user_id,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000)
  };
  tokenCache.set(refreshToken, session);
  return session;
}

/**
 * Convierte un valor de Firestore REST API a valor nativo de JavaScript
 */
export function fromFirestoreValue(valObj) {
  if (!valObj || typeof valObj !== "object") return null;
  if ("nullValue" in valObj) return null;
  if ("booleanValue" in valObj) return Boolean(valObj.booleanValue);
  if ("integerValue" in valObj) return Number(valObj.integerValue);
  if ("doubleValue" in valObj) return Number(valObj.doubleValue);
  if ("stringValue" in valObj) return String(valObj.stringValue);
  if ("timestampValue" in valObj) return String(valObj.timestampValue);
  if ("arrayValue" in valObj) {
    const values = valObj.arrayValue?.values || [];
    return values.map(fromFirestoreValue);
  }
  if ("mapValue" in valObj) {
    const fields = valObj.mapValue?.fields || {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

/**
 * Convierte un documento de Firestore REST API a un objeto JS
 */
export function fromFirestoreDoc(docJson) {
  if (!docJson || !docJson.fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(docJson.fields)) {
    out[k] = fromFirestoreValue(v);
  }
  return out;
}

/**
 * Convierte un valor nativo de JS al formato Value de Firestore REST API
 */
export function toFirestoreValue(val) {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === "boolean") {
    return { booleanValue: val };
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return { integerValue: "0" };
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === "string") {
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map(toFirestoreValue)
      }
    };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

/**
 * Lee un documento en Firestore usando el idToken del usuario autenticado
 */
export async function getFirestoreDoc(docPath, idToken) {
  const cleanPath = docPath.replace(/^\/+/, "");
  const headers = {};
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }
  const res = await fetch(`${FIRESTORE_BASE_URL}/${cleanPath}`, {
    method: "GET",
    headers
  });

  if (res.status === 404) {
    return { exists: false, data: null };
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error al leer Firestore (${cleanPath}): ${res.status} ${errText}`);
  }

  const json = await res.json();
  return { exists: true, data: fromFirestoreDoc(json) };
}

/**
 * Actualiza (merge) campos específicos de un documento en Firestore
 */
export async function patchFirestoreDoc(docPath, dataObj, idToken) {
  const cleanPath = docPath.replace(/^\/+/, "");
  const fieldKeys = Object.keys(dataObj).filter(k => dataObj[k] !== undefined);
  const maskParams = fieldKeys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `${FIRESTORE_BASE_URL}/${cleanPath}${maskParams ? `?${maskParams}` : ""}`;

  const fields = {};
  for (const k of fieldKeys) {
    fields[k] = toFirestoreValue(dataObj[k]);
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error al guardar en Firestore (${cleanPath}): ${res.status} ${errText}`);
  }

  const json = await res.json();
  return fromFirestoreDoc(json);
}
