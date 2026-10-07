import os
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Highest per-account scan quota a production instance will boot with. This is a
# billing decision, not a magic number: every scan in the orchestrator issues at
# least one Shodan host query against a single paid key, and that key is shared by
# every account. At 5 scans/hour one account draws at most ~3.6k Shodan queries per
# 30-day month, which leaves room inside the monthly query allowance of the entry
# paid Shodan plan *and* still covers normal interactive use (one scan per submit
# plus refreshes). At the old default of 10/hour a single legitimate account can
# draw ~7.2k queries/month — most of a monthly allowance on its own — and the cost
# scales with the number of accounts, which is exactly what the sign-up gate
# cannot fully control. Operators who genuinely need more should buy more Shodan
# credit rather than raise this: the constant is code on purpose, so raising it is
# a reviewable decision instead of a quiet env edit.
PRODUCTION_RATE_LIMIT_CEILING = 5


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
    rate_limit_per_hour: int = Field(
        default=PRODUCTION_RATE_LIMIT_CEILING,
        ge=1,
        description=(
            "Per-account scan quota per rolling hour. Defaults to the production "
            "ceiling so dev and prod cannot drift apart."
        ),
    )
    # Opt-in instance-wide cost backstop: max *admitted* scans per rolling 24h
    # across all accounts, measured in hourly buckets. 0 = disabled (default), so
    # existing deployments see no behaviour change. It exists because the hourly
    # quota cannot express a budget for the shared key: N accounts each inside
    # their own quota still add up.
    rate_limit_daily_total: int = Field(default=0, ge=0)
    # Absolute ceiling on live per-user bucket keys. The periodic sweep only bounds
    # growth relative to arrival rate ("keys touched in the last ~65 minutes"), not
    # absolute size. 10k live users is already far past what one Shodan key should
    # serve (10k x 5 scans/hour is ~3.6M Shodan queries/month), so this is a
    # cost ceiling as much as a memory one, and comfortably above any legitimate
    # instance size for this product.
    rate_limit_max_keys: int = Field(default=10000, ge=1)
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
            # Fail closed on the scan quota. Every account spends the same paid
            # Shodan key, so an unset quota is a silent budget decision. The field
            # default cannot distinguish "unset" from "deliberately 5", so presence
            # is checked in the process environment (os.getenv), the same way
            # is_production reads APP_ENV/NODE_ENV. Note the consequence: a value
            # that exists only in a backend/.env *file* inside the container is not
            # visible here, so production deployments must pass it as a real
            # environment variable (compose `environment:`, platform env settings).
            # That is the fail-closed direction (AGENTS.md §5, "when in doubt: fail
            # closed") and the error message says where to set it.
            raw_quota = os.getenv("RATE_LIMIT_PER_HOUR")
            if raw_quota is None or not raw_quota.strip():
                raise ValueError(
                    "RATE_LIMIT_PER_HOUR must be set in the process environment in "
                    f"production (1-{PRODUCTION_RATE_LIMIT_CEILING})"
                )
            try:
                quota = int(raw_quota.strip())
            except ValueError as e:
                raise ValueError(
                    "RATE_LIMIT_PER_HOUR must be a whole number in production"
                ) from e
            if quota < 1:
                raise ValueError("RATE_LIMIT_PER_HOUR must be at least 1 in production")
            if quota > PRODUCTION_RATE_LIMIT_CEILING:
                raise ValueError(
                    "RATE_LIMIT_PER_HOUR must be at most "
                    f"{PRODUCTION_RATE_LIMIT_CEILING} in production; one Shodan key "
                    "is shared by every account. To allow more, change "
                    "PRODUCTION_RATE_LIMIT_CEILING in app/core/config.py as a "
                    "deliberate billing decision"
                )


settings = Settings()
