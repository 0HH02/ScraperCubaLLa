import "dotenv/config";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_SEARCH_NAMES = 10;
const CATALOG_BATCH_SIZE = 50;
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

function parseNamesFromText(text) {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .map((s) => String(s).trim().toLowerCase())
          .filter(isUsefulSearchName)
          .slice(0, MAX_SEARCH_NAMES);
      }
    } catch {
      /* ignore */
    }
  }

  return trimmed
    .split(/[\n,;]+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, "").trim().toLowerCase())
    .filter(isUsefulSearchName)
    .slice(0, MAX_SEARCH_NAMES);
}

function sanitizeNames(names) {
  if (!Array.isArray(names)) return [];
  return [
    ...new Set(
      names
        .map((s) => String(s).trim().toLowerCase())
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

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function requestCatalogSearchNames(batch, apiKey) {
  const productos = JSON.stringify(
    batch.map((item) => ({ codigo: item.codigo, nombre: item.nombre })),
    null,
    2,
  );
  const prompt = CATALOG_PROMPT_TEMPLATE.replace("{{productos}}", productos);
  const url = `${API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
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

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const result = { nombres: fallbackSimilarNames(nombre), source: "fallback" };
    nameCache.set(cacheKey, result);
    return result;
  }

  const prompt = PROMPT_TEMPLATE.replace("{{nombre}}", nombre);
  const url = `${API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  const nombres = parseNamesFromText(text);

  const result =
    nombres.length === 0
      ? { nombres: fallbackNames(nombre), source: "fallback" }
      : { nombres, source: "gemini" };

  nameCache.set(cacheKey, result);
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
    for (const item of pending) {
      const fallback = { nombres: fallbackNames(item.nombre), source: "fallback" };
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
  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const from = i * CATALOG_BATCH_SIZE + 1;
      const to = from + batch.length - 1;
      onProgress?.(
        `Esperando respuesta de Gemini (lote ${i + 1}/${batches.length}, productos ${from}–${to})…`,
      );
      const batchNames = await requestCatalogSearchNames(batch, apiKey);
      for (const [codigo, names] of batchNames) {
        parsed.set(codigo, names);
      }
      onProgress?.(`Lote ${i + 1}/${batches.length} recibido.`);
    }
  } catch (err) {
    console.warn(`Gemini: no se pudieron generar nombres por lote (${err.message})`);
    onProgress?.(`Gemini falló (${err.message}); usando nombres automáticos para el resto.`);
  }

  for (const item of pending) {
    const cacheKey = item.nombre.trim().toLowerCase();
    const names =
      parsed.get(item.codigo) ??
      ({ nombres: fallbackNames(item.nombre), source: "fallback" });
    nameCache.set(cacheKey, names);
    result.set(item.codigo, names);
  }

  return result;
}

export async function getSimilarProductNames({ nombre, precioCuballama }) {
  const cacheKey = `${nombre.trim().toLowerCase()}|${precioCuballama ?? ""}`;
  if (similarNameCache.has(cacheKey)) {
    return similarNameCache.get(cacheKey);
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const result = { nombres: fallbackSimilarNames(nombre), source: "fallback" };
    similarNameCache.set(cacheKey, result);
    return result;
  }

  const prompt = SIMILAR_PRODUCTS_PROMPT_TEMPLATE
    .replace("{{nombre}}", nombre)
    .replace("{{precio}}", precioCuballama == null ? "desconocido" : String(precioCuballama));
  const url = `${API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 512 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    const nombres = parseNamesFromText(text);
    const result =
      nombres.length === 0
        ? { nombres: fallbackNames(nombre), source: "fallback" }
        : { nombres, source: "gemini" };
    similarNameCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`Gemini: no se pudieron generar productos similares (${err.message})`);
    const result = { nombres: fallbackNames(nombre), source: "fallback" };
    similarNameCache.set(cacheKey, result);
    return result;
  }
}
