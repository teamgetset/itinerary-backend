# GETSET API image for Render (Docker service). Includes Chromium, which prints the itinerary PDFs.
# Configuration comes from environment variables set on the host (see docs/PRODUCTION_ENVIRONMENT_AUDIT.md);
# no .env file, credentials or local data are copied into the image (.dockerignore).

FROM node:22-bookworm-slim AS build
WORKDIR /app
# The test-only MongoDB binary is not needed in an image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# Chromium for PDFs, and fonts for what the bundled Mona Sans font does not cover (the dirham sign's Arabic letters,
# the rupee sign), so prices never print as empty boxes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PDF_BROWSER_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
