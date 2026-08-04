FROM node:20-alpine

# better-sqlite3 and pg both ship prebuilds, but the toolchain is needed if a
# prebuild is missing for this platform.
RUN apk add --no-cache python3 make g++ curl

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY src ./src

# Uploaded evidence and backups live on a volume, not in the image.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://localhost:4000/health || exit 1

CMD ["node", "src/index.js"]
