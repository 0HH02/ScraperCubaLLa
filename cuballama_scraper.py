import logging
import re
from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin, urlparse

from playwright.sync_api import Browser, BrowserContext, Locator, Page, Playwright, sync_playwright

import settings

logger = logging.getLogger(__name__)

TODOS_NEGOCIOS_RE = re.compile(r"todos\s+los\s+negocios?", re.I)
STORE_URL_RE = re.compile(settings.STORE_URL_PATTERN, re.I)
PRODUCT_URL_RE = re.compile(settings.PRODUCT_URL_PATTERN, re.I)
PRICE_RE = re.compile(r"(\$|USD|CUP|€|EUR)\s*[\d.,]+|[\d.,]+\s*(USD|CUP|€)", re.I)
PRICE_PER_MEASURE_RE = re.compile(
    r"[\d.,]+\s*/\s*(?:kg|g|lb|oz|uni|unidad|u|l|ml|m|m2|m²|pieza|paq)",
    re.I,
)

AT_BOTTOM_JS = """() => {
    const y = window.scrollY + window.innerHeight;
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    return h - y < 80;
}"""

LINK_EXTRACT_JS = """(els) => els.map((e) => ({
    href: e.href,
    text: (e.innerText || e.getAttribute("aria-label") || "").trim()
}))"""


def block_heavy_resources(route, request) -> None:
    if request.resource_type in ("image", "media", "font"):
        route.abort()
    else:
        route.continue_()


def create_browser_context(
    playwright: Playwright, *, headless: bool = True, block_resources: bool = False
) -> tuple[Browser, BrowserContext, Page]:
    browser = playwright.chromium.launch(headless=headless)
    context = browser.new_context(
        locale="es-ES",
        viewport={"width": 1366, "height": 900},
    )
    page = context.new_page()
    page.set_default_timeout(settings.DEFAULT_TIMEOUT_MS)
    page.set_default_navigation_timeout(settings.DEFAULT_TIMEOUT_MS)
    if block_resources:
        page.route("**/*", block_heavy_resources)
    return browser, context, page


def dismiss_overlays(page: Page) -> None:
    for label in ("Aceptar", "Aceptar todo", "Entendido", "Cerrar"):
        try:
            btn = page.get_by_role("button", name=re.compile(label, re.I)).first
            if btn.is_visible(timeout=2000):
                btn.click(timeout=3000)
                page.wait_for_timeout(500)
        except Exception:
            pass


def safe_goto(page: Page, url: str) -> None:
    last_error: Exception | None = None
    for attempt in range(1, settings.NAV_RETRIES + 1):
        try:
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(1000)
            return
        except Exception as exc:
            last_error = exc
            logger.warning(
                "Error navegando a %s (intento %d/%d): %s",
                url,
                attempt,
                settings.NAV_RETRIES,
                exc,
            )
            if attempt < settings.NAV_RETRIES:
                page.wait_for_timeout(settings.NAV_RETRY_BACKOFF_MS * attempt)
    raise RuntimeError(f"No se pudo cargar {url}") from last_error


def scroll_until_stable(
    page: Page,
    count_fn,
    *,
    max_rounds: int = 60,
    pause_ms: int = 2000,
    stable_rounds: int = settings.SCROLL_STABLE_ROUNDS,
) -> int:
    """Scroll clásico (sección tiendas en inicio)."""
    prev_count = -1
    stable = 0
    for _ in range(max_rounds):
        count = count_fn()
        if count == prev_count:
            stable += 1
            if stable >= stable_rounds:
                break
        else:
            stable = 0
        prev_count = count
        page.evaluate(
            "() => window.scrollBy(0, Math.max(window.innerHeight, 600))"
        )
        page.wait_for_timeout(pause_ms)
    page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(pause_ms)
    return count_fn()


def scroll_collect_until_stable(
    page: Page,
    collect_fn: Callable[[], int],
    *,
    max_rounds: int = settings.SCROLL_MAX_ROUNDS,
    pause_ms: int = settings.SCROLL_PAUSE_MS,
    stable_at_bottom: int = settings.SCROLL_STABLE_AT_BOTTOM,
) -> int:
    """
    Scroll incremental rápido: en cada paso se recogen ítems visibles (solo nuevos).
    Para cuando está al fondo y lleva N scrolls sin añadir nada nuevo.
    """
    stable = 0
    total = 0
    step = settings.SCROLL_STEP_RATIO
    for i in range(max_rounds):
        nuevos = collect_fn()
        total += nuevos
        at_bottom = page.evaluate(AT_BOTTOM_JS)

        if at_bottom and nuevos == 0:
            stable += 1
            if stable >= stable_at_bottom:
                logger.debug(
                    "Scroll finalizado en ronda %d (stable=%d)", i, stable
                )
                break
        else:
            stable = 0

        page.evaluate(
            f"window.scrollBy(0, Math.round(window.innerHeight * {step}))"
        )
        page.wait_for_timeout(pause_ms)
    return total


def _normalize_url(base: str, href: str) -> str | None:
    if not href or href.startswith("#") or href.startswith("javascript:"):
        return None
    full = urljoin(base, href.strip())
    parsed = urlparse(full)
    if parsed.scheme not in ("http", "https"):
        return None
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def _link_text(anchor: Locator) -> str:
    text = anchor.inner_text(timeout=5000).strip()
    if text:
        return re.sub(r"\s+", " ", text)
    aria = anchor.get_attribute("aria-label")
    if aria:
        return aria.strip()
    title = anchor.get_attribute("title")
    return title.strip() if title else ""


def _find_todos_negocios_section(page: Page) -> Locator:
    heading = page.get_by_role(
        "heading", name=TODOS_NEGOCIOS_RE
    ).or_(page.get_by_text(TODOS_NEGOCIOS_RE)).first
    heading.wait_for(state="visible", timeout=settings.DEFAULT_TIMEOUT_MS)
    heading.scroll_into_view_if_needed()
    return heading.locator(
        "xpath=ancestor::section[1] | ancestor::motion.div[1] | ancestor::motion.div[1] | ancestor::div[contains(@class,'section') or contains(@class,'Section')][1] | ancestor::div[3]"
    )


def _is_store_href(href: str) -> bool:
    if STORE_URL_RE.search(href):
        return True
    if PRODUCT_URL_RE.search(href):
        return False
    if "/mercado/inicio" in href or href.rstrip("/").endswith("/mercado"):
        return False
    # rutas tipo /mercado/nombre-tienda sin subruta producto
    if re.search(r"/mercado/[^/]+/?$", href, re.I):
        return True
    return False


def _is_product_href(href: str) -> bool:
    if PRODUCT_URL_RE.search(href):
        return True
    if re.search(r"/mercado/[^/]+/[^/]+", href, re.I) and not _is_store_href(href):
        return True
    return False


def extract_links_from_locator(
    page: Page, root: Locator, url_filter
) -> list[tuple[str, str]]:
    seen: set[str] = set()
    results: list[tuple[str, str]] = []
    anchors = root.locator("a[href]")
    count = anchors.count()
    for i in range(count):
        anchor = anchors.nth(i)
        try:
            href = anchor.get_attribute("href")
            if not href:
                continue
            full = _normalize_url(page.url, href)
            if not full or full in seen or not url_filter(full):
                continue
            nombre = _link_text(anchor)
            if not nombre or len(nombre) < 2:
                slug = urlparse(full).path.rstrip("/").split("/")[-1]
                nombre = slug.replace("-", " ").title()
            seen.add(full)
            results.append((nombre, full))
        except Exception:
            continue
    return results


def _count_store_links(page: Page, section: Locator) -> int:
    links = extract_links_from_locator(page, section, _is_store_href)
    return len(links)


def scrape_tiendas(page: Page) -> list[tuple[str, str]]:
    logger.info("Cargando página de inicio: %s", settings.INICIO_URL)
    safe_goto(page, settings.INICIO_URL)
    dismiss_overlays(page)

    try:
        section = _find_todos_negocios_section(page)
    except Exception:
        logger.warning(
            "No se encontró heading 'Todos los Negocios'; usando página completa."
        )
        section = page.locator("body")

    logger.info("Desplazando para cargar todos los negocios...")
    scroll_until_stable(
        page,
        lambda: _count_store_links(page, section),
    )

    tiendas = extract_links_from_locator(page, section, _is_store_href)
    if not tiendas:
        logger.info("Pocos resultados en sección; buscando en toda la página...")
        scroll_until_stable(
            page,
            lambda: len(extract_links_from_locator(page, page.locator("body"), _is_store_href)),
        )
        tiendas = extract_links_from_locator(
            page, page.locator("body"), _is_store_href
        )

    logger.info("Tiendas encontradas: %d", len(tiendas))
    return tiendas


def _extract_price_from_card(card: Locator) -> str:
    try:
        text = card.inner_text(timeout=3000)
    except Exception:
        return ""
    match = PRICE_RE.search(text)
    return match.group(0).strip() if match else ""


def _parse_prices_from_text(text: str) -> tuple[str | None, str | None]:
    """Separa precio total y precio por magnitud (kg, uni, etc.)."""
    precio_por_magnitud: str | None = None
    per_match = PRICE_PER_MEASURE_RE.search(text)
    if per_match:
        precio_por_magnitud = per_match.group(0).strip() or None

    precio: str | None = None
    for match in PRICE_RE.finditer(text):
        candidate = match.group(0).strip()
        if precio_por_magnitud and candidate in precio_por_magnitud:
            continue
        precio = candidate
        break

    return precio, precio_por_magnitud


def _slug_name(href: str) -> str:
    slug = href.rstrip("/").split("/")[-1]
    return slug.replace("-", " ").title()


def _product_from_anchor(
    anchor: Locator, full: str, nombre_hint: str
) -> dict[str, Any] | None:
    try:
        nombre = nombre_hint.strip() if nombre_hint else ""
        if not nombre or len(nombre) < 2:
            nombre = _link_text(anchor)
        if not nombre or len(nombre) < 2:
            nombre = _slug_name(full)

        card = anchor.locator(
            "xpath=ancestor::article[1] | ancestor::li[1] | ancestor::motion.div[1] | ancestor::motion.div[1] | ancestor::div[contains(@class,'card') or contains(@class,'Card') or contains(@class,'product')][1]"
        )
        descripcion = ""
        precio: str | None = None
        precio_por_magnitud: str | None = None
        if card.count() > 0:
            card_el = card.first
            try:
                full_text = card_el.inner_text(timeout=3000)
                lines = [
                    ln.strip()
                    for ln in full_text.splitlines()
                    if ln.strip() and ln.strip() != nombre
                ]
                precio, precio_por_magnitud = _parse_prices_from_text(full_text)
                desc_lines = [
                    ln
                    for ln in lines
                    if not PRICE_RE.search(ln)
                    and not PRICE_PER_MEASURE_RE.search(ln)
                    and ln != nombre
                ]
                descripcion = " ".join(desc_lines[:3])[:500]
            except Exception:
                pass
        if precio is None and precio_por_magnitud is None:
            anchor_text = ""
            try:
                anchor_text = anchor.inner_text(timeout=3000)
            except Exception:
                pass
            precio, precio_por_magnitud = _parse_prices_from_text(anchor_text)

        return {
            "nombre": nombre,
            "link": full,
            "descripcion": descripcion,
            "precio": precio,
            "precio_por_magnitud": precio_por_magnitud,
        }
    except Exception:
        return None


def _menu_item_to_product(item: dict[str, Any]) -> dict[str, Any]:
    slug = (item.get("slug") or "").strip()
    product_id = item.get("id")
    if slug:
        link = f"{settings.BASE_URL}/mercado/producto/{slug}"
    elif product_id:
        link = f"{settings.BASE_URL}/mercado/producto/{product_id}"
    else:
        link = ""

    precio: str | None = None
    if item.get("price") is not None:
        currency = (item.get("currency") or "USD").strip()
        precio = f"${item['price']} {currency}"

    precio_por_magnitud = (item.get("priceByMeasure") or "").strip() or None

    return {
        "nombre": (item.get("name") or "").strip(),
        "link": link,
        "descripcion": ((item.get("description") or "").strip())[:500],
        "precio": precio,
        "precio_por_magnitud": precio_por_magnitud,
    }


def _ingest_menu_payload(
    data: dict[str, Any], seen: dict[str, dict[str, Any]]
) -> int:
    """Añade productos de businessMenu que aún no están en seen."""
    added = 0
    for item in data.get("list") or []:
        if not isinstance(item, dict):
            continue
        producto = _menu_item_to_product(item)
        link = producto.get("link")
        nombre = producto.get("nombre")
        if not link or not nombre or link in seen:
            continue
        seen[link] = producto
        added += 1
    return added


def _collect_visible_products(
    page: Page, seen: dict[str, dict[str, Any]]
) -> int:
    """Añade productos visibles en pantalla que aún no están en seen."""
    try:
        items = page.eval_on_selector_all("a[href]", LINK_EXTRACT_JS)
    except Exception as exc:
        logger.debug("No se pudieron leer enlaces visibles: %s", exc)
        return 0

    added = 0
    for item in items:
        href = item.get("href")
        if not href:
            continue
        full = _normalize_url(page.url, href)
        if not full or full in seen or not _is_product_href(full):
            continue

        nombre_hint = (item.get("text") or "").strip().split("\n")[0]
        slug = urlparse(full).path.rstrip("/").split("/")[-1]
        anchor = page.locator(f"a[href*='{slug}']").first
        producto = None
        if anchor.count() > 0:
            producto = _product_from_anchor(anchor, full, nombre_hint)
        if not producto:
            producto = {
                "nombre": nombre_hint or _slug_name(full),
                "link": full,
                "descripcion": "",
                "precio": None,
                "precio_por_magnitud": None,
            }

        seen[full] = producto
        added += 1
    return added


def scrape_productos_tienda(page: Page, link_tienda: str) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    prev_total = 0

    def on_menu_response(response) -> None:
        if "businessMenu" not in response.url or response.status != 200:
            return
        try:
            data = response.json()
        except Exception:
            return
        if isinstance(data, dict):
            _ingest_menu_payload(data, seen)

    page.on("response", on_menu_response)
    try:
        safe_goto(page, link_tienda)
        dismiss_overlays(page)
        page.wait_for_timeout(settings.STORE_PAGE_WAIT_MS)

        if "login" in page.url.lower() or "cuenta" in page.url.lower():
            raise RuntimeError(f"Redirección a login: {page.url}")

        def collect() -> int:
            nonlocal prev_total
            _collect_visible_products(page, seen)
            total = len(seen)
            nuevos = total - prev_total
            prev_total = total
            return nuevos

        logger.info("Desplazando para cargar productos (scroll incremental)...")
        scroll_collect_until_stable(page, collect)
    finally:
        page.remove_listener("response", on_menu_response)

    productos = list(seen.values())
    logger.info("Productos detectados: %d", len(productos))
    return productos


def run_scraper(
    db_path,
    *,
    solo_tiendas: bool = False,
    solo_productos: bool = False,
    headless: bool = True,
) -> None:
    import db

    db.init_db(db_path)

    with sync_playwright() as playwright:
        browser, context, page = create_browser_context(
            playwright, headless=headless
        )
        try:
            with db.get_connection(db_path) as conn:
                if not solo_productos:
                    tiendas = scrape_tiendas(page)
                    ins, ign = db.upsert_tiendas(conn, tiendas)
                    logger.info(
                        "Tiendas guardadas: %d nuevas, %d ya existían",
                        ins,
                        ign,
                    )

                if not solo_tiendas:
                    pendientes = db.get_tiendas_pendientes(conn)
                    logger.info("Tiendas pendientes de productos: %d", len(pendientes))
                    for row in pendientes:
                        id_tienda = row["ID"]
                        nombre = row["Nombre"]
                        link = row["Link"]
                        logger.info("Scrapeando tienda: %s (%s)", nombre, link)
                        try:
                            productos = scrape_productos_tienda(page, link)
                            nuevos = db.insert_productos(
                                conn, id_tienda, productos
                            )
                            db.marcar_tienda_completada(conn, id_tienda)
                            logger.info(
                                "  → %d productos nuevos (%d total en página)",
                                nuevos,
                                len(productos),
                            )
                        except Exception as exc:
                            logger.error(
                                "Error en tienda %s: %s", nombre, exc
                            )
                        page.wait_for_timeout(settings.PAUSA_ENTRE_TIENDAS_MS)

                total_t = db.contar_tiendas(conn)
                total_p = db.contar_productos(conn)
                logger.info("Resumen BD: %d tiendas, %d productos", total_t, total_p)
        finally:
            context.close()
            browser.close()
