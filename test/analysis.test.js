import assert from "node:assert/strict";
import fs from "node:fs";
import { before, test } from "node:test";

import { DB_PATH, initDatabase } from "../server/db.js";
import { analyzeProduct } from "../server/analysis.js";

const hayBaseDeDatos = fs.existsSync(DB_PATH);
const opciones = hayBaseDeDatos
  ? {}
  : { skip: "No hay cuballama_market.db en el proyecto." };

before(async () => {
  if (hayBaseDeDatos) await initDatabase();
});

const TIPO_CAMBIO = 575;

function analizar(nombre, precioVenta, nombres = []) {
  return analyzeProduct({ codigo: "T1", nombre, precioVenta }, TIPO_CAMBIO, { nombres });
}

test("encuentra publicaciones comparables del mercado", opciones, () => {
  const row = analizar("COCINA DE INDUCCION", 25000);

  assert.ok(row.cantidadPublicaciones > 0, "debería encontrar publicaciones");
  assert.equal(typeof row.precioMin, "number");
  assert.ok(row.precioMin <= row.precioMedio);
});

test("las estadísticas se calculan sobre las publicaciones semejantes", opciones, () => {
  const row = analizar("COCINA DE INDUCCION", 25000);

  if (row.cantidadSemejantes > 0) {
    assert.equal(row.baseEstadisticas, "semejantes");
    const precios = row.publicacionesSemejantes.map((p) => p.precio);
    assert.equal(row.precioMin, Math.min(...precios));
  }
});

test("un producto sin coincidencias no inventa precios", opciones, () => {
  const row = analizar("XKQZTV PRODUCTO INEXISTENTE 9999", 1000);

  assert.equal(row.cantidadPublicaciones, 0);
  assert.equal(row.precioMin, null);
  assert.equal(row.precioMedio, null);
  assert.equal(row.sinPublicaciones, true);
});

test("las etiquetas manuales amplían la búsqueda", opciones, () => {
  const sinEtiqueta = analizar("XKQZTV APARATO", 25000);
  const conEtiqueta = analizar("XKQZTV APARATO", 25000, ["cocina de induccion"]);

  assert.equal(sinEtiqueta.cantidadPublicaciones, 0);
  assert.ok(conEtiqueta.cantidadPublicaciones > 0);
});

test("todas las publicaciones traen precio numérico", opciones, () => {
  const row = analizar("COCINA DE INDUCCION", 25000);

  for (const pub of row.publicaciones) {
    assert.equal(typeof pub.precio, "number", `precio no numérico en ${pub.nombre}`);
    assert.ok(pub.precio > 0);
  }
});

test("analizar el catálogo completo es rápido", opciones, () => {
  const inicio = performance.now();
  for (let i = 0; i < 300; i++) {
    analizar("COCINA DE INDUCCION", 25000);
  }
  const msPorProducto = (performance.now() - inicio) / 300;

  assert.ok(msPorProducto < 20, `demasiado lento: ${msPorProducto.toFixed(1)} ms/producto`);
});
