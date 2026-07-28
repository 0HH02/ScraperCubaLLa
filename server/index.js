import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeCatalog, analyzeProduct, analyzeSimilarProducts } from "./analysis.js";
import { ensureFreshDatabase, getMarketStats, initDatabase } from "./db.js";
import { parseCatalogFromBuffer } from "./excel.js";
import { getSimilarProductNames, isGeminiConfigured } from "./gemini.js";
import { searchMarketProducts } from "./marketSearch.js";

function parseTipoCambio(value) {
  const n = Number.parseFloat(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Indica un tipo de cambio válido (moneda local por 1 USD, mayor que 0).");
  }
  return n;
}

function optionalTipoCambio(value) {
  const n = Number.parseFloat(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function normalizeTag(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const PORT = Number(process.env.PORT) || 3000;
// Solo local por defecto: la app no tiene autenticación y consume una API de pago.
const HOST = process.env.HOST || "127.0.0.1";
const publicDir = path.join(__dirname, "..", "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

/**
 * Límite simple por ventana para las rutas que gastan cuota de Gemini.
 * Evita que un bucle en el navegador dispare la factura sin darse cuenta.
 */
function rateLimit({ windowMs, max }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? "local";

    if (hits.size > 500) {
      for (const [ip, data] of hits) {
        if (now > data.resetAt) hits.delete(ip);
      }
    }

    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const segundos = Math.ceil((entry.resetAt - now) / 1000);
      return res.status(429).json({
        error: `Demasiadas peticiones seguidas. Espera ${segundos} s e inténtalo otra vez.`,
      });
    }

    entry.count += 1;
    next();
  };
}

const aiLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const analyzeLimiter = rateLimit({ windowMs: 60_000, max: 10 });

app.get("/api/health", (_req, res) => {
  try {
    ensureFreshDatabase();
    res.json({ ok: true, geminiConfigurado: isGeminiConfigured(), ...getMarketStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function writeAnalyzeEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

/** Evita que el navegador corte el stream si Gemini o el análisis tardan. */
function startAnalyzeHeartbeat(res, stream) {
  if (!stream) return () => {};
  const timer = setInterval(() => {
    if (res.writableEnded) return;
    writeAnalyzeEvent(res, {
      type: "heartbeat",
      message: "El análisis sigue en curso…",
    });
  }, 10_000);
  return () => clearInterval(timer);
}

app.post("/api/analyze", analyzeLimiter, upload.single("file"), async (req, res) => {
  const stream = req.query.stream === "1" || req.get("accept")?.includes("application/x-ndjson");
  let stopHeartbeat = () => {};

  try {
    if (!req.file) {
      const err = { error: "Debes subir un archivo Excel (.xlsx o .xls)." };
      return stream
        ? res.status(400).end(`${JSON.stringify({ type: "error", ...err })}\n`)
        : res.status(400).json(err);
    }

    const onProgress = stream
      ? (message) => writeAnalyzeEvent(res, { type: "progress", message })
      : undefined;

    if (stream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      writeAnalyzeEvent(res, { type: "progress", message: "Leyendo inventario desde el Excel…" });
      stopHeartbeat = startAnalyzeHeartbeat(res, stream);
    }

    ensureFreshDatabase();
    const tipoCambio = parseTipoCambio(req.body?.tipoCambio);
    const catalog = parseCatalogFromBuffer(req.file.buffer);
    onProgress?.(`Inventario leído: ${catalog.length} producto(s).`);

    const rows = await analyzeCatalog(catalog, tipoCambio, onProgress);
    const stats = getMarketStats();
    const payload = {
      rows,
      total: rows.length,
      market: stats,
      uploadedFile: req.file.originalname,
    };

    stopHeartbeat();
    if (stream) {
      writeAnalyzeEvent(res, { type: "complete", ...payload });
      return res.end();
    }

    res.json(payload);
  } catch (err) {
    stopHeartbeat();
    if (stream && !res.headersSent) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    }
    if (stream && res.headersSent) {
      writeAnalyzeEvent(res, { type: "error", error: err.message });
      return res.end();
    }
    if (stream && !res.headersSent) {
      return res.status(400).end(`${JSON.stringify({ type: "error", error: err.message })}\n`);
    }
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/analyze-json", analyzeLimiter, async (req, res) => {
  try {
    const catalog = req.body?.items;
    if (!Array.isArray(catalog) || catalog.length === 0) {
      return res.status(400).json({ error: "Se espera un arreglo 'items' con productos." });
    }

    ensureFreshDatabase();
    const tipoCambio = parseTipoCambio(req.body?.tipoCambio);
    const rows = await analyzeCatalog(catalog, tipoCambio);
    res.json({ rows, total: rows.length, market: getMarketStats() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/market-search", (req, res) => {
  try {
    const q = String(req.query?.q ?? "").trim();
    if (!q) {
      return res.status(400).json({ error: "Indica un término de búsqueda (parámetro q)." });
    }
    const result = searchMarketProducts(q, {
      cupPerUsd: optionalTipoCambio(req.query?.tipoCambio),
    });
    if (!result.tokens.length) {
      return res.status(400).json({
        error: "Escribe al menos una palabra de 2 o más caracteres.",
      });
    }
    res.json({ ok: true, query: q, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/similar-products", aiLimiter, async (req, res) => {
  try {
    const nombre = String(req.body?.nombre ?? "").trim();
    if (!nombre) {
      return res.status(400).json({ error: "Se espera el nombre del producto." });
    }

    ensureFreshDatabase();
    const precioCuballama =
      req.body?.precioCuballama == null ? null : Number(req.body.precioCuballama);
    const result = await analyzeSimilarProducts({
      nombre,
      precioCuballama: Number.isFinite(precioCuballama) ? precioCuballama : null,
      tipoCambio: optionalTipoCambio(req.body?.tipoCambio),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/suggest-tag", aiLimiter, async (req, res) => {
  try {
    const nombre = String(req.body?.nombre ?? "").trim();
    if (!nombre) {
      return res.status(400).json({ error: "Se espera el nombre del producto." });
    }

    const precioCuballama =
      req.body?.precioCuballama == null ? null : Number(req.body.precioCuballama);
    const existing = new Set((req.body?.existingTags || []).map(normalizeTag).filter(Boolean));
    existing.add(normalizeTag(nombre));

    const result = await getSimilarProductNames({
      nombre,
      precioCuballama: Number.isFinite(precioCuballama) ? precioCuballama : null,
    });
    const tag = result.nombres?.find((term) => !existing.has(normalizeTag(term))) || null;

    res.json({
      ok: true,
      tag,
      fuenteNombresBusqueda: result.source,
      // Explica por qué la sugerencia no vino de la IA (cuota, red, sin clave…).
      motivo: result.motivo ?? null,
      nombresBusqueda: result.nombres,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/reanalyze-product", async (req, res) => {
  try {
    const item = req.body?.item;
    if (!item || typeof item !== "object") {
      return res.status(400).json({ error: "Se espera un producto para reanalizar." });
    }

    ensureFreshDatabase();
    const tipoCambio = parseTipoCambio(item.tipoCambio);
    const nombres = Array.isArray(item.nombresBusqueda)
      ? item.nombresBusqueda.map((name) => String(name).trim()).filter(Boolean)
      : [];
    const row = analyzeProduct(item, tipoCambio, {
      nombres,
      source: item.fuenteNombresBusqueda || "manual",
    });

    res.json({ ok: true, row });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Endpoint no encontrado." });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

initDatabase()
  .then(() => {
    const stats = getMarketStats();
    console.log(
      `BD cargada: ${stats.productos} productos activos de ${stats.tiendas} tiendas` +
        (stats.datosActualizados ? ` (últimos datos: ${stats.datosActualizados})` : ""),
    );
    if (!isGeminiConfigured()) {
      console.warn(
        "Gemini no configurado: se usarán términos de búsqueda automáticos. " +
          "Copia .env.example a .env y añade GEMINI_API_KEY.",
      );
    }
    app.listen(PORT, HOST, () => {
      console.log(`Analizador de precios: http://localhost:${PORT}`);
      if (HOST !== "127.0.0.1") {
        console.warn(`Escuchando en ${HOST}: el servidor es accesible desde la red y no tiene contraseña.`);
      }
    });
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
