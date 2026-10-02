import os
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000"
    database_url: str = "sqlite+aiosqlite:///./data/cache.db"
    sqlite_path: str = "./data/cache.db"
    cache_backend: Literal["sqlite", "postgres"] = "sqlite"
    shodan_api_key: str = ""
    better_auth_secret: str = "change-me-32-chars-min"
    scan_timeout_shodan: int = 12
    scan_timeout_crtsh: int = 30
    scan_timeout_whois: int = 10
    rate_limit_per_hour: int = 10
    cache_ttl_hours: int = 24

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return os.getenv("APP_ENV", "").lower() == "production" or os.getenv(
            "NODE_ENV", ""
        ).lower() == "production"

    def model_post_init(self, __context):
        if self.is_production and (
            not self.better_auth_secret
            or self.better_auth_secret in {"change-me-32-chars-min", "dev-secret-min-32-chars-change-me-xxxx"}
        ):
            raise ValueError("BETTER_AUTH_SECRET must be set to a non-default value in production")


settings = Settings()
