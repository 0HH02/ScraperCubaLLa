import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeCatalog, analyzeProduct, analyzeSimilarProducts, clearMarketCache } from "./analysis.js";
import { getMarketStats, initDatabase } from "./db.js";
import { parseCatalogFromBuffer } from "./excel.js";
import { getSimilarProductNames } from "./gemini.js";
import { searchMarketProducts } from "./marketSearch.js";

function parseTipoCambio(value) {
  const n = Number.parseFloat(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Indica un tipo de cambio válido (moneda local por 1 USD, mayor que 0).");
  }
  return n;
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
const publicDir = path.join(__dirname, "..", "public");

app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

app.get("/api/health", (_req, res) => {
  try {
    const stats = getMarketStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function writeAnalyzeEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  const stream = req.query.stream === "1" || req.get("accept")?.includes("application/x-ndjson");

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
      res.setHeader("Cache-Control", "no-cache");
      res.flushHeaders?.();
      writeAnalyzeEvent(res, { type: "progress", message: "Leyendo inventario desde el Excel…" });
    }

    clearMarketCache();
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

    if (stream) {
      writeAnalyzeEvent(res, { type: "complete", ...payload });
      return res.end();
    }

    res.json(payload);
  } catch (err) {
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

app.post("/api/analyze-json", async (req, res) => {
  try {
    const catalog = req.body?.items;
    if (!Array.isArray(catalog) || catalog.length === 0) {
      return res.status(400).json({ error: "Se espera un arreglo 'items' con productos." });
    }

    clearMarketCache();
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
    const result = searchMarketProducts(q);
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

app.post("/api/similar-products", async (req, res) => {
  try {
    const nombre = String(req.body?.nombre ?? "").trim();
    if (!nombre) {
      return res.status(400).json({ error: "Se espera el nombre del producto." });
    }

    clearMarketCache();
    const precioCuballama =
      req.body?.precioCuballama == null ? null : Number(req.body.precioCuballama);
    const result = await analyzeSimilarProducts({
      nombre,
      precioCuballama: Number.isFinite(precioCuballama) ? precioCuballama : null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/suggest-tag", async (req, res) => {
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

    clearMarketCache();
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

initDatabase()
  .then(() => {
    const stats = getMarketStats();
    console.log(`BD cargada: ${stats.productos} productos, ${stats.tiendas} tiendas`);
    app.listen(PORT, () => {
      console.log(`Analizador de precios: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
