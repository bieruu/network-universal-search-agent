import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import PRODUCTION_RATE_LIMIT_CEILING, Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_EXAMPLE = REPO_ROOT / "backend" / ".env.example"
ALEMBIC_ENV = REPO_ROOT / "backend" / "alembic" / "env.py"
DOCKER_COMPOSE = REPO_ROOT / "docker-compose.yml"

GOOD_SECRET = "s3cr3t-shared-value-32chars!!-extra"


def prod_settings(monkeypatch, quota=None, **overrides) -> Settings:
    """Build Settings as production would, with only the scan quota under test.

    `_env_file=None` keeps a developer's filled `backend/.env` from deciding the
    outcome; `quota=None` means "RATE_LIMIT_PER_HOUR is not in the process
    environment", which is the state the production guard must refuse.
    """
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("NODE_ENV", raising=False)
    if quota is None:
        monkeypatch.delenv("RATE_LIMIT_PER_HOUR", raising=False)
    else:
        monkeypatch.setenv("RATE_LIMIT_PER_HOUR", quota)
    kwargs = {
        "_env_file": None,
        "better_auth_secret": GOOD_SECRET,
        "cors_origins": "https://osint.example",
        # localhost Postgres is exempt from the sslmode guard (dev/staging shape),
        # so this helper fails only on the rule under test.
        "database_url": "postgresql+asyncpg://user:pass@localhost:5432/osint",
    }
    kwargs.update(overrides)
    return Settings(**kwargs)


def non_prod_settings(monkeypatch, **overrides) -> Settings:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.delenv("RATE_LIMIT_PER_HOUR", raising=False)
    return Settings(_env_file=None, **overrides)


def read_env_value(path: Path, key: str) -> str:
    """Minimal KEY=VALUE reader — never loads the example into os.environ."""
    prefix = f"{key}="
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    raise AssertionError(f"{key} not found in {path.name}")


def read_compose_default(compose: str, key: str) -> str:
    """Read the `${KEY:-default}` value docker compose actually applies."""
    match = re.search(rf"{key}:\s*\$\{{{key}:-([^}}]*)\}}", compose)
    assert match, f"no ${{{key}:-default}} entry for {key} in docker-compose.yml"
    return match.group(1)


def test_env_example_database_url_uses_asyncpg_driver():
    # Regression: the example shipped `postgresql://`, which makes the backend
    # fail at boot: psycopg is not installed, only asyncpg is.
    url = read_env_value(ENV_EXAMPLE, "DATABASE_URL")
    assert urlsplit(url).scheme == "postgresql+asyncpg"
    engine = create_async_engine(url)
    assert engine.url.drivername == "postgresql+asyncpg"


def test_env_example_database_url_matches_compose_credentials():
    url = read_env_value(ENV_EXAMPLE, "DATABASE_URL")
    compose = DOCKER_COMPOSE.read_text(encoding="utf-8")
    assert urlsplit(url).username == read_compose_default(compose, "POSTGRES_USER")
    assert urlsplit(url).path.lstrip("/") == read_compose_default(
        compose, "POSTGRES_DB"
    )


def test_alembic_fallback_url_matches_compose_credentials():
    # Read the file, never import it: alembic/env.py runs migrations on import.
    source = ALEMBIC_ENV.read_text(encoding="utf-8")
    match = re.search(r'os\.getenv\(\s*"DATABASE_URL",\s*"(?P<url>[^"]+)"\s*\)', source)
    assert match, "DATABASE_URL fallback not found in alembic/env.py"
    url = match.group("url")
    assert urlsplit(url).scheme == "postgresql+asyncpg"

    compose = DOCKER_COMPOSE.read_text(encoding="utf-8")
    assert urlsplit(url).username == read_compose_default(compose, "POSTGRES_USER")
    assert urlsplit(url).path.lstrip("/") == read_compose_default(
        compose, "POSTGRES_DB"
    )


def test_plain_postgres_url_is_not_engine_constructible():
    # Pins the reason the example must keep `+asyncpg`: the sync scheme tries to
    # import psycopg, which is absent from requirements.
    with pytest.raises(ModuleNotFoundError):
        create_async_engine("postgresql://owner:pw@localhost:5432/osint")


# --- production scan-quota guard (RATE_LIMIT_PER_HOUR) -----------------------


def test_production_refuses_unset_scan_quota(monkeypatch):
    """No env value = no stated budget = refuse to boot.

    Every account spends the same paid Shodan key, so booting with an implicit
    per-account quota is a silent billing decision (AGENTS.md §5.5).
    """
    with pytest.raises(ValidationError, match="RATE_LIMIT_PER_HOUR"):
        prod_settings(monkeypatch)


def test_production_refuses_unparseable_scan_quota(monkeypatch):
    """Field validation rejects these before model_post_init even runs, so both
    the type error and the production guard have to keep refusing them."""
    for raw in ("abc", "5.5", "", "   ", "1_0"):
        with pytest.raises(ValidationError) as e:
            prod_settings(monkeypatch, quota=raw)
        # Either the pydantic type error or our own guard — never a boot.
        assert "rate_limit_per_hour" in str(e.value).lower()


def test_production_refuses_non_positive_scan_quota(monkeypatch):
    for raw in ("0", "-1", "-100"):
        with pytest.raises(ValidationError) as e:
            prod_settings(monkeypatch, quota=raw)
        assert "rate_limit_per_hour" in str(e.value).lower()


def test_production_refuses_scan_quota_above_ceiling(monkeypatch):
    with pytest.raises(ValidationError, match="at most"):
        prod_settings(monkeypatch, quota=str(PRODUCTION_RATE_LIMIT_CEILING + 1))
    # The ceiling itself and anything lower is an accepted operator decision.
    assert prod_settings(monkeypatch, quota=str(PRODUCTION_RATE_LIMIT_CEILING))
    assert prod_settings(monkeypatch, quota="1")


def test_production_scan_quota_must_come_from_the_process_environment(monkeypatch):
    """A field value alone cannot prove intent — `rate_limit_per_hour=3` as an init
    kwarg is not "set", and neither is a value that only exists in a backend/.env
    file inside the container (pydantic reads it, os.getenv does not)."""
    with pytest.raises(ValidationError, match="RATE_LIMIT_PER_HOUR"):
        prod_settings(monkeypatch, quota=None, rate_limit_per_hour=3)


def test_non_production_boots_with_the_default_scan_quota(monkeypatch):
    settings = non_prod_settings(monkeypatch)

    assert settings.rate_limit_per_hour == PRODUCTION_RATE_LIMIT_CEILING
    # Shipped defaults: the daily cost backstop is opt-in (0) and the key ceiling
    # is on, so an operator who deploys without touching either stays bounded.
    assert settings.rate_limit_daily_total == 0
    assert settings.rate_limit_max_keys >= 1


def test_hourly_default_cannot_drift_above_the_production_ceiling():
    """Env-proof pin: the dev default is what production is allowed to be, so a
    future bump cannot quietly make development more permissive than deploys."""
    default = Settings.model_fields["rate_limit_per_hour"].default
    assert default <= PRODUCTION_RATE_LIMIT_CEILING


def test_key_ceiling_and_daily_cap_validate_their_own_ranges(monkeypatch):
    with pytest.raises(ValidationError):
        non_prod_settings(monkeypatch, rate_limit_max_keys=0)
    with pytest.raises(ValidationError):
        non_prod_settings(monkeypatch, rate_limit_daily_total=-1)
