# yzy-4nbt-solana-pay — Railway / Render / any Docker host
# Builds native better-sqlite3 on Debian bookworm.
FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# Install all deps (incl. tsx). NODE_ENV unset so npm does not omit optional build tools.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 8787

# Persist SQLite: mount a volume at /data (Railway Volume → mount path /data)

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
