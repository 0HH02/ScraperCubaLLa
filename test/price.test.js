import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePriceText, parsePriceUsd, toUsd } from "../server/price.js";

test("lee el formato que produce el scraper", () => {
  assert.deepEqual(parsePriceText("$12.99 USD"), {
    amount: 12.99,
    currency: "USD",
    raw: "$12.99 USD",
  });
  assert.equal(parsePriceText("$7.0 USD").amount, 7);
  assert.equal(parsePriceText("$1.99 USD").amount, 1.99);
});

test("interpreta separadores de millares en vez de truncar el importe", () => {
  assert.equal(parsePriceText("$1,299.00").amount, 1299);
  assert.equal(parsePriceText("1.299,50 CUP").amount, 1299.5);
  assert.equal(parsePriceText("$1,250").amount, 1250);
  assert.equal(parsePriceText("2.500.000").amount, 2500000);
});

test("distingue decimales de millares por la cantidad de dígitos", () => {
  assert.equal(parsePriceText("12,5").amount, 12.5);
  assert.equal(parsePriceText("12.50").amount, 12.5);
  assert.equal(parsePriceText("1,299").amount, 1299);
});

test("detecta la moneda del anuncio", () => {
  assert.equal(parsePriceText("400 CUP").currency, "CUP");
  assert.equal(parsePriceText("€10").currency, "EUR");
  assert.equal(parsePriceText("25 MLC").currency, "MLC");
  assert.equal(parsePriceText("$5").currency, "USD");
  assert.equal(parsePriceText("15").currency, null);
});

test("ignora textos sin importe", () => {
  assert.equal(parsePriceText(""), null);
  assert.equal(parsePriceText(null), null);
  assert.equal(parsePriceText("consultar precio"), null);
});

test("no cuenta un precio en CUP como si fueran dólares", () => {
  const cup = parsePriceText("2400 CUP");
  assert.equal(toUsd(cup, { cupPerUsd: 400 }), 6);
  // Sin tipo de cambio el importe queda fuera de la comparación.
  assert.equal(toUsd(cup), null);
});

test("convierte euros solo con tasa explícita", () => {
  const eur = parsePriceText("10 EUR");
  assert.equal(toUsd(eur, { usdPerEur: 1.1 }), 11);
  assert.equal(toUsd(eur), null);
});

test("el MLC se compara a la par del dólar", () => {
  assert.equal(parsePriceUsd("30 MLC"), 30);
});
