import * as XLSX from "xlsx";

const COLUMN_ALIASES = {
  codigo: ["codigo", "código", "code", "sku", "id"],
  nombre: [
    "nombre",
    "producto",
    "descripcion",
    "descripción",
    "name",
    "mercancia",
    "mercancía",
  ],
  precioVenta: [
    "precio de venta",
    "precio venta",
    "precio_venta",
    "precioventa",
    "pvp",
    "p.venta",
    "p venta",
    "precio",
    "venta",
  ],
  inventario: [
    "cantidad",
    "existencia",
    "stock",
    "stok",
    "inventario",
    "qty",
    "cant",
  ],
};

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function findColumnKey(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = normalized.findIndex((h) => aliases.includes(h));
    if (index >= 0) mapping[field] = index;
  }

  return mapping;
}

function findHeaderRowIndex(rows) {
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const headers = rows[i].map((h) => String(h));
    const mapping = findColumnKey(headers);
    if (mapping.codigo != null && mapping.nombre != null && mapping.precioVenta != null) {
      return { headerIndex: i, mapping, headers };
    }
  }
  return null;
}

function getTextContent(file) {
  return file?.content ? file.content.toString("utf8") : "";
}

function getRedFontIds(stylesXml) {
  const fontIds = new Set();
  const fontMatches = stylesXml.matchAll(/<font\b[\s\S]*?<\/font>/g);
  let index = 0;

  for (const match of fontMatches) {
    const fontXml = match[0];
    if (/<color\b[^>]*rgb="(?:FF)?FF0000"/i.test(fontXml)) {
      fontIds.add(index);
    }
    index += 1;
  }

  return fontIds;
}

function getStyleIdsWithFonts(stylesXml, fontIds) {
  const styleIds = new Set();
  const cellXfsMatch = stylesXml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/);
  if (!cellXfsMatch) return styleIds;

  const xfMatches = cellXfsMatch[0].matchAll(/<xf\b[^>]*\/?>/g);
  let index = 0;

  for (const match of xfMatches) {
    const fontId = Number.parseInt(match[0].match(/\bfontId="(\d+)"/)?.[1] ?? "", 10);
    if (fontIds.has(fontId)) {
      styleIds.add(index);
    }
    index += 1;
  }

  return styleIds;
}

function getRedRows(workbook) {
  const stylesXml = getTextContent(workbook.files?.["xl/styles.xml"]);
  const sheetXml = getTextContent(workbook.files?.["xl/worksheets/sheet1.xml"]);
  if (!stylesXml || !sheetXml) return new Set();

  const redStyleIds = getStyleIdsWithFonts(stylesXml, getRedFontIds(stylesXml));
  if (redStyleIds.size === 0) return new Set();

  const rows = new Set();
  const cellMatches = sheetXml.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"[^>]*\bs="(\d+)"[^>]*>/g);

  for (const match of cellMatches) {
    const rowNumber = Number.parseInt(match[2], 10);
    const styleId = Number.parseInt(match[3], 10);
    if (redStyleIds.has(styleId)) {
      rows.add(rowNumber);
    }
  }

  return rows;
}

function parseInventario(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  const text = String(value).trim().replace(/[^\d.,-]/g, "");
  if (!text) return null;

  const num = Number.parseFloat(text.replace(",", "."));
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : null;
}

function parsePrice(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  let text = String(value).trim().replace(/[^\d.,-]/g, "");
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const after = text.slice(lastComma + 1);
    if (after.length === 3 && !text.includes(".")) {
      text = text.replace(/,/g, "");
    } else {
      text = text.replace(",", ".");
    }
  }

  const num = Number.parseFloat(text);
  return Number.isFinite(num) ? num : null;
}

export function parseCatalogFromBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", bookFiles: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("El archivo Excel no contiene hojas.");
  }
  const redRows = getRedRows(workbook);

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: true,
  });

  if (rows.length < 2) {
    throw new Error("El Excel debe tener encabezados y al menos una fila de datos.");
  }

  const headerInfo = findHeaderRowIndex(rows);
  if (!headerInfo) {
    const firstHeaders = rows[0].map((h) => String(h)).join(", ");
    throw new Error(
      "No se encontró fila de encabezados con código, nombre/mercancía y precio. " +
        `Primeras columnas: ${firstHeaders}`,
    );
  }

  const { headerIndex, mapping } = headerInfo;
  const items = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((cell) => String(cell ?? "").trim() === "")) continue;

    const codigo = String(row[mapping.codigo] ?? "").trim();
    const nombre = String(row[mapping.nombre] ?? "").trim();
    const precioVenta = parsePrice(row[mapping.precioVenta]);
    const inventario =
      mapping.inventario != null ? parseInventario(row[mapping.inventario]) : null;
    const marcadoRojo = redRows.has(i + 1);

    if (!codigo && !nombre) continue;
    if (!codigo && nombre) continue;

    items.push({ codigo, nombre, precioVenta, inventario, marcadoRojo });
  }

  if (items.length === 0) {
    throw new Error("No se encontraron filas válidas en el Excel.");
  }

  return items;
}
