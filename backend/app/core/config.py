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
    # Keyword-search fallback, used ONLY when the CPE path yields nothing.
    # Small because every term costs a rate-limited NVD request (6s apart, 0.7s
    # with a key) and a keyword hit is a lead, not host evidence.
    nvd_max_keywords: int = 3
    nvd_cves_per_keyword: int = 10
    # --- v2 analysis sources -------------------------------------------------
    # Every field below is optional and read defensively via getattr() by its
    # service, so a deployment that sets none of them still boots and each
    # source reports `not_configured` instead of silently failing. A blank
    # secret is a supported state, not a misconfiguration: these sources cost
    # money or need an operator's own credentials, so the key is a deliberate
    # budget decision rather than a boot blocker.
    scan_timeout_dns: int = 10
    # Leak-Lookup: the key is free but is REQUIRED, and the free tier is capped
    # at 10 queries/day. Its ToS restricts queries to targets the operator is
    # authorised to search, so wiring it to arbitrary signed-in users is an
    # operator decision, not a default.
    leaklookup_api_key: str = ""
    scan_timeout_leaklookup: int = 12
    # URLScan.io: read-only search needs NO key (30 req/min per IP anonymous).
    # A key is only worth setting to unlock `verdicts` and higher quotas. Free
    # tier history depth is capped upstream at 30 days and 100 results/page —
    # do not let the UI promise "full history".
    urlscan_api_key: str = ""
    scan_timeout_urlscan: int = 12
    # Threat-intel sources. See each service's docstring for what is verified
    # about its key requirement and limits; a blank key is a supported state.
    # OTX answers several endpoints with no key at all, at a lower rate limit.
    virustotal_api_key: str = ""
    scan_timeout_virustotal: int = 12
    otx_api_key: str = ""
    scan_timeout_otx: int = 12
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
    # Per-account hourly quota for capabilities that cost no Shodan credit
    # (offline phone validation, contact extraction, EXIF). Kept separate from
    # `rate_limit_per_hour` on purpose: that constant is a billing decision about
    # the shared paid key, so spending it on free work would both burn real
    # money budget and let a cheap endpoint exhaust a user's scan allowance.
    # Looser than the scan quota because these paths do no paid fan-out, but
    # still bounded — contact extraction is an address-harvesting primitive.
    free_rate_limit_per_hour: int = Field(default=20, ge=1)
    # Subjects exempt from BOTH rate-limit buckets, for load/QA testing.
    #
    # Comma-separated exact `require_user()` subjects. The intended value is
    # `user:service`, which `require_user` returns ONLY for a bearer token that
    # matches `SERVICE_TOKEN` under hmac.compare_digest — a secret that never
    # reaches a browser. A session-cookie subject is always `user:<db-id>` and is
    # therefore never exempt by default, so a stolen cookie or an XSS cannot
    # become an unlimited draw on the paid Shodan key. See rate_limit._is_exempt.
    #
    # Default empty: nobody is exempt until an operator opts in by name.
    rate_limit_exempt_subjects: str = ""
    cache_ttl_hours: int = 24
    # Target-fetching budgets (see app/core/ssrf.py). These bound the one path
    # where the backend connects to an attacker-chosen host, so they are
    # deliberately small: a redirect chain that runs long is a redirect loop, and
    # a body larger than the cap is not something a header/cookie/sitemap
    # summary needs. max_redirects also bounds how many DNS resolutions a single
    # request can trigger.
    fetch_timeout_seconds: int = 10
    fetch_max_redirects: int = 10
    fetch_max_bytes: int = 1_048_576

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
