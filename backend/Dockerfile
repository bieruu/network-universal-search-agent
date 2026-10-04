# syntax=docker/dockerfile:1
FROM golang:1.25-alpine AS subfinder-builder

ARG SUBFINDER_VERSION=v2.16.0
RUN CGO_ENABLED=0 go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@${SUBFINDER_VERSION}

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv/app

COPY --from=subfinder-builder /go/bin/subfinder /usr/local/bin/subfinder

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./alembic.ini
COPY alembic ./alembic
COPY app ./app

EXPOSE 8000

# $PORT is provided by Fly/Render; default 8000 for `docker run` without -e.
CMD ["sh", "-c", "python -m alembic upgrade head && python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
