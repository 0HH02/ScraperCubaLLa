import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.resolve(__dirname, "..", "cuballama_market.db");

let db = null;
let initPromise = null;

export async function initDatabase() {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(`No se encontró la base de datos: ${DB_PATH}`);
    }

    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    return db;
  })();

  return initPromise;
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

export function getMarketStats() {
  const productos = queryOne("SELECT COUNT(*) AS n FROM Producto")?.n ?? 0;
  const tiendas = queryOne("SELECT COUNT(*) AS n FROM Tienda")?.n ?? 0;
  return { productos, tiendas, dbPath: DB_PATH };
}
