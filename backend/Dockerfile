# syntax=docker/dockerfile:1
FROM golang:1.25-alpine AS subfinder-builder

ARG SUBFINDER_VERSION=v2.16.0
RUN CGO_ENABLED=0 go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@${SUBFINDER_VERSION}

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv/app

COPY --from=subfinder-builder /go/bin/subfinder /usr/local/bin/subfinder

# Runtime dependencies only (pinned + hashed). Dev tooling lives in
# requirements-dev.txt and is never installed in the production image.
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY alembic.ini ./alembic.ini
COPY alembic ./alembic
COPY app ./app

# Non-root: uvicorn + subfinder must not run as root. The data/ dir is where
# the SQLite TTL cache is written at runtime.
RUN groupadd --system app \
    && useradd --system --gid app --home /srv/app app \
    && mkdir -p /srv/app/data \
    && chown -R app:app /srv/app

USER app

EXPOSE 8000

# $PORT is provided by Koyeb; default 8000 for `docker run` without -e.
CMD ["sh", "-c", "python -m alembic upgrade head && python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
