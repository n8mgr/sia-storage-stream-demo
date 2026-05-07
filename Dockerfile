FROM oven/bun:1.2-alpine AS build
WORKDIR /app

# Install deps first so layer caching kicks in when only source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Now the rest. .dockerignore keeps node_modules, dist, e2e, etc. out.
COPY . .

# Vite output -> /app/dist (copied to nginx in the next stage).
RUN bun run build

# ---- Runtime stage -------------------------------------------------------
FROM nginx:alpine AS runtime

# SPA fallback + service-worker cache headers + WASM mime override. See
# docker/nginx.conf for the why on each block.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
