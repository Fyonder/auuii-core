# ==========================================================
#  PONTE — WhatsApp do PC ⇄ Auuii-Backend
#  Pequena de propósito: o PC tem ~2 GB livres e já roda
#  n8n, Evolution, postgres e o AdGuard.
# ==========================================================
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# /data guarda a fila (fila.json) entre reinícios — é volume no compose.
RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production PORT=3100 PONTE_DADOS=/data
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/saude || exit 1

CMD ["node", "src/index.js"]
