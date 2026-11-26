FROM node:24.16.0-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates fonts-dejavu-core fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/extension/package.json apps/extension/package.json
COPY infra/prisma infra/prisma
RUN npm ci --workspace @noon/api --include-workspace-root --no-audit --no-fund
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
RUN npm run db:generate && npm run build --workspace @noon/api
USER node
CMD ["node","apps/api/dist/main.js"]
