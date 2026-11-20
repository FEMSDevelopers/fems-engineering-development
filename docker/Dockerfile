# Multi-stage build: compile + test in a full Node image, ship only runtime files.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages ./packages
RUN npm run build && npm test
# Drop dev dependencies and sources from the tree we copy into the runtime image.
RUN npm prune --omit=dev \
 && rm -rf packages/*/src packages/*/test packages/web/index.html packages/web/vite.config.ts packages/*/tsconfig*.json

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "packages/server/dist/index.js"]
