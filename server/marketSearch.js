import { ensureFreshDatabase, hasColumn, queryAll } from "./db.js";
import { parsePriceText, toUsd, USD } from "./price.js";

const MAX_RESULTS = 100;
const CANDIDATE_LIMIT = 2500;
const MIN_TOKEN_LEN = 2;

function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuery(query) {
  return normalizeText(query)
    .split(/\s+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN);
}

function escapeLike(term) {
  return term.replace(/[%_\\]/g, "\\$&");
}

function listingMatchesTokens(nombreNorm, tokens) {
  return tokens.every((token) => nombreNorm.includes(token));
}

/**
 * Busca publicaciones cuyo nombre contiene todas las palabras indicadas.
 */
export function searchMarketProducts(query, rates = {}) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) {
    return { productos: [], total: 0, tokens: [] };
  }

  ensureFreshDatabase();

  const soloActivos = hasColumn("Producto", "Activo");
  const tienePrecioValor = hasColumn("Producto", "Precio_Valor");
  const columnasPrecio = tienePrecioValor
    ? "p.Precio_Valor AS precioValor, p.Precio_Moneda AS precioMoneda,"
    : "NULL AS precioValor, NULL AS precioMoneda,";

  const conditions = tokens.map(() => "LOWER(p.Nombre) LIKE ? ESCAPE '\\'").join(" AND ");
  const params = tokens.map((t) => `%${escapeLike(t)}%`);

  const rows = queryAll(
    `
    SELECT p.Nombre AS nombre, ${columnasPrecio} p.Precio AS precio,
           p.Link AS link, t.Nombre AS tienda
    FROM Producto p
    JOIN Tienda t ON t.ID = p.ID_tienda
    WHERE p.Nombre IS NOT NULL AND TRIM(p.Nombre) != ''
      ${soloActivos ? "AND p.Activo = 1" : ""}
      AND ${conditions}
    ORDER BY p.Nombre
    LIMIT ?
  `,
    [...params, CANDIDATE_LIMIT],
  );

  const productos = rows
    .filter((row) => listingMatchesTokens(normalizeText(row.nombre), tokens))
    .slice(0, MAX_RESULTS)
    .map((row) => {
      const valor = Number(row.precioValor);
      const precio = Number.isFinite(valor) && valor > 0
        ? toUsd({ amount: valor, currency: row.precioMoneda || USD }, rates)
        : toUsd(parsePriceText(row.precio), rates);

      return {
        nombre: row.nombre,
        precio,
        precioTexto: row.precio ?? null,
        tienda: row.tienda,
        link: row.link ?? null,
      };
    });

  return { productos, total: productos.length, tokens };
}
