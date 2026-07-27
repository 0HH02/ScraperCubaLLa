import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.resolve(__dirname, "..", "cuballama_market.db");

/** Cada cuánto se comprueba si el scraper reescribió el archivo. */
const FRESHNESS_CHECK_MS = 2000;

let SQL = null;
let db = null;
let initPromise = null;
let loadedMtimeMs = 0;
let loadedSize = 0;
let lastCheckedAt = 0;
let version = 0;
let columnCache = new Map();

function readDatabaseFile() {
  const stats = fs.statSync(DB_PATH);
  const buffer = fs.readFileSync(DB_PATH);
  const next = new SQL.Database(buffer);

  if (db) db.close();
  db = next;
  loadedMtimeMs = stats.mtimeMs;
  loadedSize = stats.size;
  lastCheckedAt = Date.now();
  columnCache = new Map();
  version += 1;
  return db;
}

export async function initDatabase() {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(`No se encontró la base de datos: ${DB_PATH}`);
    }
    SQL = await initSqlJs();
    return readDatabaseFile();
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

/**
 * Recarga la BD si el scraper la reescribió.
 * Sin esto había que reiniciar Node para ver datos nuevos.
 */
export function ensureFreshDatabase() {
  if (!db) return false;

  const now = Date.now();
  if (now - lastCheckedAt < FRESHNESS_CHECK_MS) return false;
  lastCheckedAt = now;

  let stats;
  try {
    stats = fs.statSync(DB_PATH);
  } catch {
    return false;
  }

  if (stats.mtimeMs === loadedMtimeMs && stats.size === loadedSize) return false;

  try {
    readDatabaseFile();
    return true;
  } catch (error) {
    // Si el scraper está escribiendo justo ahora, se conserva la copia previa
    // y se reintenta en la siguiente comprobación.
    console.warn(`No se pudo recargar la BD: ${error.message}`);
    return false;
  }
}

/** Identificador de la carga actual; sirve para invalidar cachés derivadas. */
export function getDbVersion() {
  return version;
}

export function getDb() {
  if (!db) {
    throw new Error("La base de datos no está cargada. Llama a initDatabase() al iniciar el servidor.");
  }
  return db;
}

/** Convierte filas de sql.js a objetos { columna: valor }. */
function rowsToObjects(result) {
  if (!result?.length) return [];
  const { columns, values } = result[0];
  return values.map((row) =>
    Object.fromEntries(columns.map((col, i) => [col, row[i]])),
  );
}

export function queryAll(sql, params = []) {
  const conn = getDb();
  if (params.length === 0) {
    return rowsToObjects(conn.exec(sql));
  }

  const stmt = conn.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

export function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] ?? null;
}

/**
 * Indica si una columna existe. Las bases generadas antes de la migración del
 * scraper no traen Activo ni Precio_Valor, y la web debe seguir funcionando.
 */
export function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (columnCache.has(key)) return columnCache.get(key);

  let exists = false;
  try {
    exists = queryAll(`PRAGMA table_info(${table})`).some(
      (col) => col.name === column,
    );
  } catch {
    exists = false;
  }

  columnCache.set(key, exists);
  return exists;
}

export function getMarketStats() {
  const soloActivos = hasColumn("Producto", "Activo");
  const productos =
    queryOne(
      `SELECT COUNT(*) AS n FROM Producto${soloActivos ? " WHERE Activo = 1" : ""}`,
    )?.n ?? 0;
  const historicos = queryOne("SELECT COUNT(*) AS n FROM Producto")?.n ?? 0;
  const tiendas = queryOne("SELECT COUNT(*) AS n FROM Tienda")?.n ?? 0;

  let actualizado = null;
  if (hasColumn("Producto", "Ultima_Vez")) {
    actualizado = queryOne("SELECT MAX(Ultima_Vez) AS t FROM Producto")?.t ?? null;
  }

  return {
    productos,
    historicos,
    tiendas,
    dbPath: DB_PATH,
    archivoModificado: loadedMtimeMs ? new Date(loadedMtimeMs).toISOString() : null,
    datosActualizados: actualizado,
  };
}
