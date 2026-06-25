# syntax=docker/dockerfile:1

FROM node:22-alpine AS frontend-build

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then \
        export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; \
    fi; \
    npm ci

COPY frontend/index.html frontend/vite.config.js ./
COPY frontend/src ./src
RUN npm run build


FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then \
        cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca > /tmp/build-ca.crt; \
        export PIP_CERT=/tmp/build-ca.crt; \
    fi; \
    pip install --no-cache-dir --disable-pip-version-check -r requirements.txt; \
    rm -f /tmp/build-ca.crt

RUN useradd --create-home --uid 10001 appuser

COPY --chown=appuser:appuser app.py battle_api.py battle_session.py main.py persistence.py ./
COPY --chown=appuser:appuser engine ./engine
COPY --chown=appuser:appuser data ./data
COPY --chown=appuser:appuser images ./images
COPY --from=frontend-build --chown=appuser:appuser /build/frontend/dist ./frontend/dist

RUN mkdir -p /app/saves /app/images/Playing_Characters/extra/custom && \
    chown -R appuser:appuser /app/saves /app/images/Playing_Characters/extra

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/', timeout=3)" || exit 1

CMD ["python", "app.py"]
