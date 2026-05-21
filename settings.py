from pathlib import Path

BASE_URL = "https://www.cuballama.com"
INICIO_URL = f"{BASE_URL}/mercado/inicio"

DEFAULT_DB_PATH = Path(__file__).parent / "cuballama_market.db"

DEFAULT_TIMEOUT_MS = 90_000
SCROLL_PAUSE_MS = 400
SCROLL_MAX_ROUNDS = 500
SCROLL_STABLE_AT_BOTTOM = 40
SCROLL_STEP_RATIO = 0.75
STORE_PAGE_WAIT_MS = 5000

NAV_RETRIES = 3
NAV_RETRY_BACKOFF_MS = 3000
PAUSA_ENTRE_TIENDAS_MS = 2500

STORE_URL_PATTERN = r"/mercado/(?:negocio|tienda|business|store)/"
PRODUCT_URL_PATTERN = r"/mercado/(?:producto|product)/"
