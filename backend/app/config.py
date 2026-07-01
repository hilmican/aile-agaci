from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg2://aile:aile@db:5432/aile_agaci"
    secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 60 * 24 * 7  # 1 week
    upload_dir: str = "/data/uploads"

    # Seeded on first startup if no admin exists
    admin_email: str = "admin@example.com"
    admin_password: str = "admin1234"
    admin_name: str = "Yönetici"


settings = Settings()
