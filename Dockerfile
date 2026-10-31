FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Last commit date of src/data/topology.yaml, from Jenkins: .dockerignore keeps .git out of
# the context. Unset in dev; the site falls back to "unknown".
ARG TOPOLOGY_DATE
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.5-alpine
# CVE-2026-111497: upstream images still ship brotli-libs 1.2.0-r1 (fixed in 1.2.1-r0).
USER root
RUN apk add --no-cache --upgrade brotli-libs
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
# The base image already runs as 101; stated here so the pipeline's Dockerfile policy check sees it.
USER 101
