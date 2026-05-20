import sqlite3
from pathlib import Path
from typing import Any


def get_connection(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with get_connection(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS Tienda (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                Nombre TEXT NOT NULL,
                Link TEXT NOT NULL UNIQUE,
                scrape_completada INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS Producto (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                ID_tienda INTEGER NOT NULL,
                Nombre TEXT NOT NULL,
                Link TEXT NOT NULL UNIQUE,
                Descripcion TEXT NOT NULL DEFAULT '',
                Precio TEXT,
                Precio_por_Magnitud TEXT,
                FOREIGN KEY (ID_tienda) REFERENCES Tienda(ID)
            );

            CREATE INDEX IF NOT EXISTS idx_tienda_scrape
                ON Tienda(scrape_completada);
            CREATE INDEX IF NOT EXISTS idx_producto_tienda
                ON Producto(ID_tienda);
            """
        )
        _migrate_db(conn)
        conn.commit()


def _migrate_db(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(Producto)")}
    if "Precio_por_Magnitud" not in cols:
        conn.execute("ALTER TABLE Producto ADD COLUMN Precio_por_Magnitud TEXT")


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def reset_productos_y_tiendas(conn: sqlite3.Connection) -> None:
    """Borra todos los productos y marca todas las tiendas como no visitadas."""
    conn.execute("DELETE FROM Producto")
    conn.execute("UPDATE Tienda SET scrape_completada = 0")
    conn.commit()


def clear_all_data(db_path: Path) -> tuple[int, int]:
    """Borra todas las tiendas y productos. Retorna (tiendas_borradas, productos_borrados)."""
    with get_connection(db_path) as conn:
        n_tiendas = contar_tiendas(conn)
        n_productos = contar_productos(conn)
        conn.execute("DELETE FROM Producto")
        conn.execute("DELETE FROM Tienda")
        conn.execute(
            "DELETE FROM sqlite_sequence WHERE name IN ('Tienda', 'Producto')"
        )
        conn.commit()
    return n_tiendas, n_productos


def contar_tiendas_visitadas(conn: sqlite3.Connection) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM Tienda WHERE scrape_completada = 1"
    ).fetchone()[0]


def upsert_tiendas(
    conn: sqlite3.Connection, tiendas: list[tuple[str, str]]
) -> tuple[int, int]:
    """Inserta tiendas nuevas. Retorna (insertadas, ignoradas)."""
    insertadas = 0
    ignoradas = 0
    for nombre, link in tiendas:
        cur = conn.execute(
            "INSERT OR IGNORE INTO Tienda (Nombre, Link) VALUES (?, ?)",
            (nombre.strip(), link.strip()),
        )
        if cur.rowcount:
            insertadas += 1
        else:
            ignoradas += 1
    conn.commit()
    return insertadas, ignoradas


def insert_productos(
    conn: sqlite3.Connection,
    id_tienda: int,
    productos: list[dict[str, Any]],
) -> int:
    """Inserta productos nuevos. Retorna cantidad insertada."""
    insertadas = 0
    for p in productos:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO Producto
                (ID_tienda, Nombre, Link, Descripcion, Precio, Precio_por_Magnitud)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                id_tienda,
                p["nombre"].strip(),
                p["link"].strip(),
                (p.get("descripcion") or ""),
                _optional_text(p.get("precio")),
                _optional_text(p.get("precio_por_magnitud")),
            ),
        )
        if cur.rowcount:
            insertadas += 1
    conn.commit()
    return insertadas


def get_tiendas_pendientes(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT ID, Nombre, Link
        FROM Tienda
        WHERE scrape_completada = 0
        ORDER BY ID
        """
    ).fetchall()


def marcar_tienda_completada(conn: sqlite3.Connection, id_tienda: int) -> None:
    conn.execute(
        "UPDATE Tienda SET scrape_completada = 1 WHERE ID = ?",
        (id_tienda,),
    )
    conn.commit()


def contar_tiendas(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM Tienda").fetchone()[0]


def contar_productos(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM Producto").fetchone()[0]
