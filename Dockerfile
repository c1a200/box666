FROM node:20-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --registry https://registry.npmmirror.com && \
    npm rebuild esbuild better-sqlite3
COPY . .
RUN npm run build:node

RUN npm prune --omit=dev --ignore-scripts

FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends tzdata && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=5678
ENV DATA_DIR=/app/data
ENV TZ=Asia/Shanghai
EXPOSE 5678

CMD ["node", "dist/server.js"]

