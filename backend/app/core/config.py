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
    # Separate machine-to-machine token for `Authorization: Bearer ...`.
    # Never reuse better_auth_secret here (it signs session cookies).
    service_token: str = ""
    scan_timeout_shodan: int = 12
    scan_timeout_crtsh: int = 30
    scan_timeout_whois: int = 10
    scan_timeout_nvd: int = 12
    nvd_api_key: str = ""
    nvd_max_cpes: int = 5
    nvd_cves_per_cpe: int = 20
    nvd_page_size: int = 100
    rate_limit_per_hour: int = 10
    cache_ttl_hours: int = 24

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return (
            os.getenv("APP_ENV", "").lower() == "production"
            or os.getenv("NODE_ENV", "").lower() == "production"
        )

    def model_post_init(self, __context, /):
        if self.is_production and (
            not self.better_auth_secret
            or len(self.better_auth_secret) < 32
            or self.better_auth_secret
            in {"change-me-32-chars-min", "dev-secret-min-32-chars-change-me-xxxx"}
            or self.better_auth_secret.lower().startswith(
                ("replace-with", "change-me", "dev-secret", "your-secret")
            )
        ):
            raise ValueError(
                "BETTER_AUTH_SECRET must be set to a non-default value in production"
            )

        if self.is_production:
            # CORS "*" + allow_credentials=True reflects any origin — never allow
            # it in production.
            if "*" in self.cors_list:
                raise ValueError(
                    "CORS_ORIGINS must not contain '*' in production; list explicit origins"
                )
            # Fail closed on plaintext database connections in production. Local
            # Docker Postgres (localhost) stays exempt for development.
            db = self.database_url.lower()
            if db.startswith(("postgresql://", "postgresql+asyncpg://")):
                host = db.split("@", 1)[-1].split("/", 1)[0].split(":", 1)[0]
                local = host in {"localhost", "127.0.0.1", "::1"}
                tls = "sslmode=require" in db or "ssl=require" in db
                if not local and not tls:
                    raise ValueError(
                        "DATABASE_URL must use sslmode=require in production"
                    )


settings = Settings()
