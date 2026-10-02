# DebtFree Coach v2 — production image
FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/debtfree.db

EXPOSE 3000

# /data should be a persistent volume/disk so SQLite survives restarts
CMD ["node", "server.js"]
