"""Normalización de precios capturados como texto libre.

El scraper obtiene precios desde el API de la tienda ("$12.99 USD") y también
desde el DOM, donde pueden aparecer con separador de millares o en otra moneda.
Guardar solo el texto obligaba al consumidor a re-interpretarlo, así que aquí se
extraen importe y moneda una sola vez.
"""

from __future__ import annotations

import re

USD = "USD"

_CURRENCY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bCUP\b|\bMN\b|\bmoneda\s+nacional\b", re.I), "CUP"),
    (re.compile(r"\bMLC\b", re.I), "MLC"),
    (re.compile(r"\bEUR\b|€", re.I), "EUR"),
    (re.compile(r"\bUSD\b|\bUS\$|\bd[oó]lares?\b", re.I), USD),
]

_AMOUNT_RE = re.compile(r"\d[\d.,\u00a0\s]*\d|\d")


def detect_currency(text: str) -> str | None:
    for pattern, currency in _CURRENCY_PATTERNS:
        if pattern.search(text):
            return currency
    return USD if "$" in text else None


def _parse_amount(raw: str) -> float | None:
    cleaned = re.sub(r"[\s\u00a0]", "", raw)
    if not cleaned:
        return None

    last_dot = cleaned.rfind(".")
    last_comma = cleaned.rfind(",")

    if last_dot != -1 and last_comma != -1:
        decimal_sep = "." if last_dot > last_comma else ","
        thousand_sep = "," if decimal_sep == "." else "."
        normalized = cleaned.replace(thousand_sep, "").replace(decimal_sep, ".")
    else:
        sep = "." if last_dot != -1 else ("," if last_comma != -1 else None)
        if sep is None:
            normalized = cleaned
        else:
            parts = cleaned.split(sep)
            decimals = parts[-1]
            # Tres dígitos finales indican millares; uno o dos, decimales.
            if len(parts) > 2 or len(decimals) == 3:
                normalized = "".join(parts)
            else:
                normalized = "".join(parts[:-1]) + "." + decimals

    try:
        value = float(normalized)
    except ValueError:
        return None
    return value if value >= 0 else None


def parse_price(text: str | None) -> tuple[float | None, str | None]:
    """Devuelve (importe, moneda). Ambos pueden ser None si no se reconoce."""
    if text is None:
        return None, None
    raw = str(text).strip()
    if not raw:
        return None, None

    match = _AMOUNT_RE.search(raw)
    if not match:
        return None, None

    return _parse_amount(match.group(0)), detect_currency(raw)
