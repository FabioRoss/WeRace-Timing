# ---- Stage 1: build the React frontend ----
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Python runtime ----
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

# DejaVu TTFs for the Open Graph result-preview cards (the slim image ships none)
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Layout must mirror the repo: main.py resolves the SPA at ../../frontend/dist
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt
COPY backend/ backend/
COPY --from=frontend /build/dist frontend/dist

WORKDIR /app/backend
EXPOSE 8000
# Single worker only: event state and websocket hubs are in-memory per process.
# --proxy-headers trusts Caddy's X-Forwarded-Proto/Host so request-derived share
# links get the real https scheme + the domain the visitor actually used (needed
# for correct per-domain links when WRB_PUBLIC_BASE_URL is left empty).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
