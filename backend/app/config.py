from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg2://aile:aile@db:5432/aile_agaci"

    @field_validator("database_url")
    @classmethod
    def _normalize_database_url(cls, value: str) -> str:
        """Accept legacy/short Postgres URLs and force the psycopg2 dialect.

        SQLAlchemy 2.x does not recognise the bare ``postgres://`` scheme
        (raises NoSuchModuleError), and ``postgresql://`` defaults to a driver
        that may not be installed. Normalise both to ``postgresql+psycopg2://``.
        """
        if value.startswith("postgres://"):
            return "postgresql+psycopg2://" + value[len("postgres://"):]
        if value.startswith("postgresql://"):
            return "postgresql+psycopg2://" + value[len("postgresql://"):]
        return value
    secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 60 * 24 * 7  # 1 week
    upload_dir: str = "/data/uploads"

    # Seeded on first startup if no admin exists
    admin_email: str = "admin@example.com"
    admin_password: str = "admin1234"
    admin_name: str = "Yönetici"


settings = Settings()
