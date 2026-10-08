# Build context: repository root
#   docker build -f gateway/Dockerfile -t zalo-gateway .

# 1. Build zca-js from this repository's source and pack it
FROM node:22-alpine AS lib
WORKDIR /lib
COPY package.json package-lock.json tsconfig.json .npmignore index.d.ts ./
RUN npm ci --ignore-scripts
COPY scripts ./scripts
COPY src ./src
RUN node scripts/buildAPI.js \
    && npx tsc \
    && mkdir /out \
    && npm pack --ignore-scripts --pack-destination /out \
    && mv /out/zca-js-*.tgz /out/zca-js.tgz

# 2. Build the gateway against the packed library
FROM node:22-alpine AS gateway
WORKDIR /app
COPY --from=lib /out/zca-js.tgz /tmp/zca-js.tgz
COPY gateway/package.json gateway/tsconfig.json ./
RUN npm pkg set dependencies.zca-js=file:/tmp/zca-js.tgz && npm install --no-audit --no-fund
COPY gateway/src ./src
RUN npx tsc && npm prune --omit=dev --no-audit --no-fund

# 3. Runtime image
FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=gateway /app/package.json ./
COPY --from=gateway /app/node_modules ./node_modules
COPY --from=gateway /app/dist ./dist
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
