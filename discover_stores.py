import json
import sys
import traceback

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

import settings

SELECTOR = "a[href*='/mercado/negocio/']"
EXTRACT_JS = """(els) => els.map((e) => {
    const text = (e.innerText || e.getAttribute("aria-label") || "").trim().split("\\n")[0];
    return { href: e.href, text };
})"""
SCROLL_PAUSE_MS = 400
STABLE_AT_BOTTOM = 40
MAX_ROUNDS = 500

AT_BOTTOM_JS = """() => {
    const y = window.scrollY + window.innerHeight;
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    return h - y < 80;
}"""


def _slug_name(href: str) -> str:
    slug = href.rstrip("/").split("/")[-1]
    return slug.replace("-", " ").title()


def _collect_visible(page, seen: dict) -> int:
    """Añade negocios visibles en pantalla que aún no están en seen."""
    try:
        items = page.eval_on_selector_all(SELECTOR, EXTRACT_JS)
    except PlaywrightError as e:
        print(f"  aviso: no se pudo leer enlaces ({e})", flush=True)
        return 0

    added = 0
    for item in items:
        href = item.get("href")
        if not href or href in seen:
            continue
        text = (item.get("text") or "").strip() or _slug_name(href)
        seen[href] = text
        added += 1
    return added


def _write_json(path: str, data) -> None:
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except PermissionError:
        alt = path.replace(".json", "_nuevo.json")
        print(f"  aviso: {path} está en uso; guardando en {alt}", flush=True)
        with open(alt, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(locale="es-ES", viewport={"width": 1366, "height": 900})
        page = context.new_page()
        page.set_default_timeout(120000)
        api_urls: set[str] = set()

        page.on(
            "response",
            lambda r: api_urls.add(r.url)
            if r.request.resource_type in ("xhr", "fetch") and "cuballama" in r.url
            else None,
        )

        print("Cargando inicio...", flush=True)
        page.goto(settings.INICIO_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(15000)

        seen: dict[str, str] = {}
        stable = 0
        stop_round = 0

        try:
            for i in range(MAX_ROUNDS):
                nuevos = _collect_visible(page, seen)
                at_bottom = page.evaluate(AT_BOTTOM_JS)

                if at_bottom and nuevos == 0:
                    stable += 1
                    if stable >= STABLE_AT_BOTTOM:
                        stop_round = i
                        break
                else:
                    stable = 0

                if i % 10 == 0:
                    print(
                        f"r{i:3d} total={len(seen):3d} nuevos={nuevos} "
                        f"fondo={at_bottom} stable={stable}",
                        flush=True,
                    )

                page.evaluate(
                    "window.scrollBy(0, Math.round(window.innerHeight * 0.75))"
                )
                page.wait_for_timeout(SCROLL_PAUSE_MS)
        except PlaywrightError as e:
            print(f"\nError de Playwright (¿cerraste el navegador?): {e}", file=sys.stderr)
            traceback.print_exc()
            return 1

        _write_json("discovered_stores.json", list(seen.items()))

        try:
            with open("discovered_api_urls.txt", "w", encoding="utf-8") as f:
                for u in sorted(api_urls):
                    f.write(u + "\n")
        except PermissionError:
            print("  aviso: discovered_api_urls.txt está en uso; no se actualizó", flush=True)

        print(
            f"\nListo: negocios={len(seen)} scroll_rounds={stop_round or i} "
            f"stable_at_bottom={stable}",
            flush=True,
        )
        context.close()
        browser.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"\nError inesperado: {e}", file=sys.stderr)
        traceback.print_exc()
        raise SystemExit(1) from e
