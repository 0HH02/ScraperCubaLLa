import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNamesFromText } from "../server/gemini.js";

test("lee un array JSON limpio", () => {
  assert.deepEqual(parseNamesFromText('["estacion de energia", "power station"]'), [
    "estacion de energia",
    "power station",
  ]);
});

test("quita las vallas de markdown", () => {
  const respuesta = '```json\n["bicicleta electrica", "moto electrica"]\n```';
  assert.deepEqual(parseNamesFromText(respuesta), [
    "bicicleta electrica",
    "moto electrica",
  ]);
});

test("se queda con la respuesta y no con el ejemplo del prompt", () => {
  const respuesta = [
    'Ejemplo para "Ecoflow Delta 2": ["estación de energía", "bluetti"]',
    '["cocina de induccion", "hornilla electrica"]',
  ].join("\n");

  assert.deepEqual(parseNamesFromText(respuesta), [
    "cocina de induccion",
    "hornilla electrica",
  ]);
});

test("no deja comillas pegadas a los términos", () => {
  const respuesta = '["cocina de induccion", \'hornilla electrica\']';
  for (const nombre of parseNamesFromText(respuesta)) {
    assert.ok(!/["'`[\]]/.test(nombre), `término con comillas: ${nombre}`);
  }
});

test("acepta comillas tipográficas", () => {
  const respuesta = '[\u201Cventilador de techo\u201D, \u201Cventilador de pie\u201D]';
  assert.deepEqual(parseNamesFromText(respuesta), [
    "ventilador de techo",
    "ventilador de pie",
  ]);
});

test("descarta palabras sueltas demasiado genéricas", () => {
  assert.deepEqual(parseNamesFromText('["lavadora", "lavadora automatica 5kg"]'), [
    "lavadora automatica 5kg",
  ]);
});

test("cae a lista por líneas cuando no hay JSON", () => {
  const respuesta = "- cocina de induccion\n- hornilla electrica";
  assert.deepEqual(parseNamesFromText(respuesta), [
    "cocina de induccion",
    "hornilla electrica",
  ]);
});
