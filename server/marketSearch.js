import { queryAll } from "./db.js";

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

function parseMarketPrice(text) {
  if (text == null || text === "") return null;
  const match = String(text).match(/[\d]+(?:[.,]\d+)?/);
  if (!match) return null;
  const num = Number.parseFloat(match[0].replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

function listingMatchesTokens(nombreNorm, tokens) {
  return tokens.every((token) => nombreNorm.includes(token));
}

/**
 * Busca publicaciones cuyo nombre contiene todas las palabras indicadas.
 */
export function searchMarketProducts(query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) {
    return { productos: [], total: 0, tokens: [] };
  }

  const conditions = tokens.map(() => "LOWER(p.Nombre) LIKE ? ESCAPE '\\'").join(" AND ");
  const params = tokens.map((t) => `%${escapeLike(t)}%`);

  const rows = queryAll(
    `
    SELECT p.Nombre AS nombre, p.Precio AS precio, p.Link AS link, t.Nombre AS tienda
    FROM Producto p
    JOIN Tienda t ON t.ID = p.ID_tienda
    WHERE p.Nombre IS NOT NULL AND TRIM(p.Nombre) != ''
      AND ${conditions}
    ORDER BY p.Nombre
    LIMIT ?
  `,
    [...params, CANDIDATE_LIMIT],
  );

  const productos = rows
    .filter((row) => listingMatchesTokens(normalizeText(row.nombre), tokens))
    .slice(0, MAX_RESULTS)
    .map((row) => ({
      nombre: row.nombre,
      precio: parseMarketPrice(row.precio),
      precioTexto: row.precio ?? null,
      tienda: row.tienda,
      link: row.link ?? null,
    }));

  return { productos, total: productos.length, tokens };
}
