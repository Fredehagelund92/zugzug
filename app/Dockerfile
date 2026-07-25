FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:1-alpine AS runtime
# server:8787 is the compose service name; override for other topologies.
ENV API_UPSTREAM=server:8787
# DNS resolver nginx uses to re-resolve API_UPSTREAM at runtime. Default is the
# Docker Compose embedded DNS; on Railway set the bracketed IPv6 [fd12::10].
ENV NGINX_RESOLVER=127.0.0.11
# Only substitute these two — leave $host/$http_upgrade/etc. untouched.
ENV NGINX_ENVSUBST_FILTER='API_UPSTREAM|NGINX_RESOLVER'
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80
