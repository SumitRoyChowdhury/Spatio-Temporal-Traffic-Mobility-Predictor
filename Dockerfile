# Production image: builds the React dashboard, then serves it together with
# the prediction API from one Python process (see training/api.py).
# DATABASE_URL must point at a PostgreSQL database holding `sensors` and
# `observations` (e.g. one filled by `python -m training.export_recent`).

FROM node:22-slim AS dashboard
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

FROM python:3.14-slim
# LightGBM and XGBoost need the OpenMP runtime.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY training/ training/
COPY model_artifacts/ model_artifacts/
COPY --from=dashboard /app/dashboard/dist dashboard/dist
EXPOSE 10000
CMD ["sh", "-c", "python -m training.api --host 0.0.0.0 --port ${PORT:-10000}"]
