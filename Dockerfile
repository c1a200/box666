FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --registry https://registry.npmmirror.com
COPY . .
RUN npm run build:node

FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends tzdata && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --registry https://registry.npmmirror.com
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=5678
ENV DATA_DIR=/app/data
ENV TZ=Asia/Shanghai
EXPOSE 5678

CMD ["node", "dist/server.js"]
