import "dotenv/config";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_SEARCH_NAMES = 10;
const CATALOG_BATCH_SIZE = 50;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const REQUEST_TIMEOUT_MS = positiveNumber(process.env.GEMINI_TIMEOUT_MS, 20_000);
const MAX_RETRIES = positiveNumber(process.env.GEMINI_MAX_RETRIES, 2);
const RETRY_BASE_DELAY_MS = 900;
const MOTIVO_NO_CONFIGURADO = "Gemini no está configurado (falta GEMINI_API_KEY).";
const GENERIC_SINGLE_TERMS = new Set([
  "lavadora",
  "nevera",
  "refrigerador",
  "televisor",
  "telefono",
  "celular",
  "laptop",
  "computadora",
  "cocina",
  "horno",
  "freidora",
  "bicicleta",
  "moto",
  "scooter",
  "aire",
  "split",
  "bateria",
  "batería",
]);

const PROMPT_TEMPLATE = `Entrega una lista de máximo 10 nombres por los cuales es conocido este producto en un mercado online cubano.
Prioriza frases específicas de 2 o más palabras cuando el producto tenga categoría, capacidad, tecnología, modelo o uso. No devuelvas palabras sueltas demasiado genéricas como "lavadora", "nevera", "televisor" o "telefono" si pueden traer accesorios, repuestos o productos no comparables.
Responde ÚNICAMENTE con un JSON array de strings en minúsculas, sin markdown ni texto adicional.

Producto: {{nombre}}

Ejemplo para "Ecoflow Delta 2": ["estación de energía", "ecoflow", "generador de energía", "estacion de carga", "bluetti"]`;

const CATALOG_PROMPT_TEMPLATE = `Necesito buscar productos de un inventario dentro de una base de datos de publicaciones de un mercado online cubano.

Para cada producto, entrega una lista de exactamente 10 nombres o términos por los cuales buscarlo en la base de datos. Incluye variantes comunes, nombres sin marca, nombres con marca/modelo, sinónimos cubanos y formas cortas útiles. Evita términos demasiado genéricos que mezclen productos distintos.

Reglas importantes:
- No devuelvas accesorios, repuestos, piezas ni consumibles del producto.
- Evita palabras sueltas de categoría cuando puedan contaminar resultados: "lavadora", "nevera", "televisor", "telefono", "laptop", etc.
- Prefiere frases específicas de 2 o más palabras: tipo, tecnología, capacidad, modelo, uso o nombre comercial.

Responde ÚNICAMENTE con un JSON válido, sin markdown ni explicación. El formato debe ser:
{
  "CODIGO_PRODUCTO": ["nombre 1", "nombre 2", "..."]
}

Productos:
{{productos}}`;

const SIMILAR_PRODUCTS_PROMPT_TEMPLATE = `Necesito encontrar productos similares en función, uso y rango de mercado para comparar contra un producto de mi inventario en un mercado online cubano.

Entrega exactamente 10 nombres o términos de búsqueda de productos similares o sustitutos que puedan aparecer publicados en ese mercado. No te limites al mismo nombre exacto: incluye marcas/modelos equivalentes, categorías funcionales y formas comunes de decirlo en Cuba. Evita términos demasiado genéricos que mezclen productos no comparables.

Reglas importantes:
- Devuelve solo productos completos comparables, no accesorios, repuestos, piezas ni consumibles.
- No uses palabras sueltas demasiado amplias si pueden mezclar accesorios o productos de otra familia.
- Prefiere frases específicas de 2 o más palabras y sustitutos que compitan en precio/uso.

Responde ÚNICAMENTE con un JSON array de strings en minúsculas, sin markdown ni texto adicional.

Producto: {{nombre}}
Precio objetivo USD: {{precio}}

Ejemplo para "Ecoflow Delta 2": ["estación de energía", "estación eléctrica", "planta eléctrica portátil", "generador solar", "power station", "oukitel", "bluetti", "jackery", "anker power station", "batería portátil de alta capacidad"]`;

function fallbackNames(nombre) {
  const norm = normalizeName(nombre);

  const words = norm.split(/\s+/).filter((w) => w.length >= 3);
  const names = [];
  if (words.length >= 2) names.push(words.slice(0, 4).join(" "));
  if (words.length >= 3) names.push(words.slice(0, 2).join(" "));
  for (const w of words) {
    if (w.length >= 5 && !GENERIC_SINGLE_TERMS.has(w) && !names.includes(w)) names.push(w);
  }
  return names.slice(0, MAX_SEARCH_NAMES);
}

function fallbackSimilarNames(nombre) {
  const norm = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

  if (/\b(ecoflow|oukitel|oupes|bluetti|jackery|estacion|bateria|power)\b/.test(norm)) {
    return [
      "estación de energía",
      "estacion electrica",
      "estación eléctrica",
      "planta electrica portatil",
      "generador solar",
      "batería portátil",
      "power station",
      "oukitel",
      "bluetti",
      "jackery",
    ];
  }

  if (/\b(bicicleta|bici|moto|scooter|triciclo)\b/.test(norm)) {
    return [
      "bicicleta electrica",
      "bici electrica",
      "moto electrica",
      "scooter electrico",
      "triciclo electrico",
      "patineta electrica",
      "bicicleta con bateria",
      "vehiculo electrico",
      "ciclomotor electrico",
      "motorina electrica",
    ];
  }

  return fallbackNames(nombre);
}

function normalizeName(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulSearchName(value) {
  const norm = normalizeName(value);
  if (norm.length < 2) return false;

  const words = norm.split(/\s+/).filter(Boolean);
  return words.length > 1 || !GENERIC_SINGLE_TERMS.has(words[0]);
}

function stripMarkdownFences(text) {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function normalizeJsonQuotes(text) {
  return String(text)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function unwrapSearchName(value) {
  let s = String(value).trim();
  if (!s) return "";

  while (/^[\["'`]|["'`\]]$/.test(s)) {
    const next = s.replace(/^[\["'`]+/, "").replace(/["'`\]]+$/, "").trim();
    if (next === s) break;
    s = next;
  }

  return s.toLowerCase();
}

function normalizeParsedNames(values) {
  return values
    .map((s) => unwrapSearchName(s))
    .filter(isUsefulSearchName)
    .slice(0, MAX_SEARCH_NAMES);
}

function extractJsonArrayFromText(text) {
  const cleaned = normalizeJsonQuotes(stripMarkdownFences(text));

  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
  } catch {
    /* ignore */
  }

  const matches = [...cleaned.matchAll(/\[[\s\S]*?\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }

  return null;
}

export function parseNamesFromText(text) {
  const parsed = extractJsonArrayFromText(text);
  if (parsed?.length) {
    return normalizeParsedNames(parsed);
  }

  return stripMarkdownFences(text)
    .split(/[\n,;]+/)
    .map((s) => unwrapSearchName(s.replace(/^[-*•\d.)\s]+/, "")))
    .filter(isUsefulSearchName)
    .slice(0, MAX_SEARCH_NAMES);
}

function sanitizeNames(names) {
  if (!Array.isArray(names)) return [];
  return [
    ...new Set(
      names
        .map((s) => unwrapSearchName(s))
        .filter(isUsefulSearchName),
    ),
  ].slice(0, MAX_SEARCH_NAMES);
}

function parseCatalogNamesFromText(text, items) {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return new Map();

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const byCode = new Map();
    for (const item of items) {
      const nombres = sanitizeNames(parsed[item.codigo]);
      if (nombres.length > 0) {
        byCode.set(item.codigo, { nombres, source: "gemini" });
      }
    }
    return byCode;
  } catch {
    return new Map();
  }
}

export class GeminiError extends Error {
  constructor(message, { status = null, retryable = false, motivo, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.retryable = retryable;
    this.motivo = motivo ?? message;
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorForStatus(status, detail, retryAfterHeader) {
  const retryAfterMs = Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : 0;
  const base = `Gemini API (${status}): ${detail}`;

  if (status === 429) {
    return new GeminiError(base, {
      status,
      retryable: true,
      retryAfterMs,
      motivo: "Gemini alcanzó su límite de peticiones. Inténtalo en unos minutos.",
    });
  }
  if (status >= 500) {
    return new GeminiError(base, {
      status,
      retryable: true,
      retryAfterMs,
      motivo: "Gemini no está disponible ahora mismo.",
    });
  }
  // Una clave inválida llega como 400, no como 401, así que se mira el detalle.
  const claveInvalida = /API[_ ]KEY[_ ]INVALID|API key not valid|PERMISSION_DENIED/i.test(detail);
  if (status === 401 || status === 403 || claveInvalida) {
    return new GeminiError(base, {
      status,
      motivo: "La clave de Gemini no es válida o no tiene permisos. Revisa GEMINI_API_KEY en el .env.",
    });
  }

  if (status === 404) {
    return new GeminiError(base, {
      status,
      motivo: `El modelo "${GEMINI_MODEL}" no existe o no está disponible para tu clave.`,
    });
  }

  return new GeminiError(base, {
    status,
    motivo: "Gemini rechazó la petición.",
  });
}

function toGeminiError(err) {
  if (err instanceof GeminiError) return err;
  if (err?.name === "AbortError") {
    return new GeminiError(`Gemini no respondió en ${REQUEST_TIMEOUT_MS} ms`, {
      retryable: true,
      motivo: "Gemini tardó demasiado en responder.",
    });
  }
  return new GeminiError(`Fallo de red con Gemini: ${err?.message ?? err}`, {
    retryable: true,
    motivo: "No hay conexión con Gemini.",
  });
}

/**
 * Llama a Gemini con tiempo límite y reintentos.
 * Sin esto, un 429 o una red caída dejaban la petición colgada o degradaban a
 * fallback sin explicar el motivo.
 */
async function callGemini({ prompt, generationConfig }) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiError("Falta GEMINI_API_KEY", { motivo: MOTIVO_NO_CONFIGURADO });
  }

  const url = `${API_BASE}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // En cabecera y no en la query para que la clave no acabe en logs.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw errorForStatus(res.status, detail.slice(0, 200), res.headers.get("retry-after"));
      }

      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    } catch (err) {
      lastError = toGeminiError(err);
      if (!lastError.retryable || attempt === MAX_RETRIES) throw lastError;

      const wait = lastError.retryAfterMs || RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `Gemini: reintento ${attempt + 1}/${MAX_RETRIES} en ${wait} ms (${lastError.message})`,
      );
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

function fallbackResult(nombres, motivo) {
  return { nombres, source: "fallback", motivo };
}

/** Un fallo puntual no debe congelarse en caché: se reintentará más tarde. */
function isCacheable(result) {
  return result.source === "gemini" || result.motivo === MOTIVO_NO_CONFIGURADO;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function requestCatalogSearchNames(batch) {
  const productos = JSON.stringify(
    batch.map((item) => ({ codigo: item.codigo, nombre: item.nombre })),
    null,
    2,
  );
  const text = await callGemini({
    prompt: CATALOG_PROMPT_TEMPLATE.replace("{{productos}}", productos),
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  });
  return parseCatalogNamesFromText(text, batch);
}

const nameCache = new Map();
const similarNameCache = new Map();

export function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export async function getProductSearchNames(nombre) {
  const cacheKey = nombre.trim().toLowerCase();
  if (nameCache.has(cacheKey)) {
    return nameCache.get(cacheKey);
  }

  let result;
  try {
    const text = await callGemini({
      prompt: PROMPT_TEMPLATE.replace("{{nombre}}", nombre),
      generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
    });
    const nombres = parseNamesFromText(text);
    result =
      nombres.length === 0
        ? fallbackResult(fallbackNames(nombre), "Gemini no devolvió términos utilizables.")
        : { nombres, source: "gemini" };
  } catch (err) {
    const geminiError = toGeminiError(err);
    console.warn(`Gemini: ${geminiError.message}`);
    result = fallbackResult(fallbackSimilarNames(nombre), geminiError.motivo);
  }

  if (isCacheable(result)) nameCache.set(cacheKey, result);
  return result;
}

export async function getCatalogSearchNames(items, onProgress) {
  const result = new Map();
  const pending = [];
  let cachedCount = 0;

  for (const item of items) {
    const cacheKey = item.nombre.trim().toLowerCase();
    if (nameCache.has(cacheKey)) {
      result.set(item.codigo, nameCache.get(cacheKey));
      cachedCount += 1;
    } else {
      pending.push(item);
    }
  }

  if (cachedCount > 0) {
    onProgress?.(
      `Reutilizando nombres en caché para ${cachedCount} producto(s) (sin llamar a Gemini).`,
    );
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || pending.length === 0) {
    if (!apiKey && pending.length > 0) {
      onProgress?.("Gemini no configurado: generando nombres de búsqueda automáticos (fallback).");
    } else if (pending.length === 0 && cachedCount > 0) {
      onProgress?.("Todos los productos ya tenían nombres en caché.");
    }
    const motivo = apiKey ? undefined : MOTIVO_NO_CONFIGURADO;
    for (const item of pending) {
      const fallback = fallbackResult(fallbackNames(item.nombre), motivo);
      nameCache.set(item.nombre.trim().toLowerCase(), fallback);
      result.set(item.codigo, fallback);
    }
    return result;
  }

  const batches = chunkArray(pending, CATALOG_BATCH_SIZE);
  onProgress?.(
    `Consultando Gemini: ${pending.length} producto(s) en ${batches.length} lote(s) de hasta ${CATALOG_BATCH_SIZE}.`,
  );

  const parsed = new Map();
  let motivoFallo;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const from = i * CATALOG_BATCH_SIZE + 1;
    const to = from + batch.length - 1;
    onProgress?.(
      `Esperando respuesta de Gemini (lote ${i + 1}/${batches.length}, productos ${from}–${to})…`,
    );

    try {
      const batchNames = await requestCatalogSearchNames(batch);
      for (const [codigo, names] of batchNames) {
        parsed.set(codigo, names);
      }
      onProgress?.(`Lote ${i + 1}/${batches.length} recibido.`);
    } catch (err) {
      // Un lote fallido ya no cancela los siguientes: antes bastaba un 429 a
      // mitad del catálogo para dejar el resto sin términos de Gemini.
      const geminiError = toGeminiError(err);
      motivoFallo = geminiError.motivo;
      console.warn(`Gemini: lote ${i + 1} falló (${geminiError.message})`);
      onProgress?.(`Lote ${i + 1}/${batches.length}: ${geminiError.motivo} Se usarán términos automáticos.`);

      if (!geminiError.retryable && geminiError.status !== 400) {
        onProgress?.("Se cancelan las llamadas restantes a Gemini.");
        break;
      }
    }
  }

  for (const item of pending) {
    const cacheKey = item.nombre.trim().toLowerCase();
    const names = parsed.get(item.codigo) ?? fallbackResult(fallbackNames(item.nombre), motivoFallo);
    if (isCacheable(names)) nameCache.set(cacheKey, names);
    result.set(item.codigo, names);
  }

  return result;
}

export async function getSimilarProductNames({ nombre, precioCuballama }) {
  const cacheKey = `${nombre.trim().toLowerCase()}|${precioCuballama ?? ""}`;
  if (similarNameCache.has(cacheKey)) {
    return similarNameCache.get(cacheKey);
  }

  const prompt = SIMILAR_PRODUCTS_PROMPT_TEMPLATE
    .replace("{{nombre}}", nombre)
    .replace("{{precio}}", precioCuballama == null ? "desconocido" : String(precioCuballama));

  let result;
  try {
    const text = await callGemini({
      prompt,
      generationConfig: { temperature: 0.35, maxOutputTokens: 512 },
    });
    const nombres = parseNamesFromText(text);
    result =
      nombres.length === 0
        ? fallbackResult(fallbackSimilarNames(nombre), "Gemini no devolvió términos utilizables.")
        : { nombres, source: "gemini" };
  } catch (err) {
    const geminiError = toGeminiError(err);
    console.warn(`Gemini: no se pudieron generar productos similares (${geminiError.message})`);
    result = fallbackResult(fallbackSimilarNames(nombre), geminiError.motivo);
  }

  if (isCacheable(result)) similarNameCache.set(cacheKey, result);
  return result;
}
