# syntax=docker/dockerfile:1
# =============================================================================
# rhdp-service — RH/DP · Folha para DRE
# Build multi-stage para EasyPanel. NestJS + Prisma (provider sqlserver).
# NÃO roda migrations (prisma migrate) — o schema é introspectado e o banco BI
# já existe. O `prisma generate` (postinstall) só gera o client.
# =============================================================================

# ---- Base builder image ----
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# openssl é necessário para o query engine do Prisma (debian-openssl-3.0.x)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Instala dependências primeiro (melhor cache de camadas)
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Instala todas as deps (dev + prod) para gerar o client e compilar
RUN npm ci

# Copia o restante do código e compila (prebuild roda `prisma generate`)
COPY . .
RUN npm run build


# ---- Runtime image ----
FROM node:20-bookworm-slim AS runner

ENV NODE_ENV=production \
    PORT=8000

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Apenas manifests e schema para um prod install limpo
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/prisma ./prisma

# Instala só dependências de produção (postinstall roda `prisma generate`)
RUN npm ci --omit=dev

# Copia o app compilado
COPY --from=builder /app/dist ./dist

# Usuário não-root por segurança
USER node

EXPOSE 8000

# Sobe o app SEM rodar migrations do Prisma
CMD ["npm", "start"]
