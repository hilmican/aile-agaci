import time

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def wait_for_db(retries: int = 30, delay: float = 2.0) -> None:
    """Block until the database accepts connections (Postgres may boot slower)."""
    last_err: Exception | None = None
    for _ in range(retries):
        try:
            with engine.connect() as conn:
                conn.exec_driver_sql("SELECT 1")
            return
        except OperationalError as err:  # pragma: no cover - startup path
            last_err = err
            time.sleep(delay)
    raise RuntimeError(f"Database not reachable after {retries} tries") from last_err
