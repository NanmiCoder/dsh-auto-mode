FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
RUN apt-get update && apt-get install -y --no-install-recommends python3 git sqlite3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY cases.mjs worker.mjs /opt/benchmark/
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/benchmark/worker.mjs"]
