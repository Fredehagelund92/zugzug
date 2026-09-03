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
# Per-IP budget for the argon2 password endpoints. nginx rate syntax ("60r/m",
# "10r/s"). 60/min plus the burst below is far above what a person signing in
# produces — including a whole office behind one NAT address — and far below
# what spraying credentials needs.
ENV AUTH_RATE_LIMIT=60r/m
# Range of a proxy in front of nginx whose X-Forwarded-For may be believed when
# recovering the client address. Loopback by default, which means "nginx is the
# edge" and the direct peer is used. Set this on platforms that front the
# container (e.g. Railway) or every visitor shares one throttle bucket.
ENV TRUSTED_PROXY_CIDR=127.0.0.1
# Only substitute these — leave $host/$http_upgrade/$binary_remote_addr/etc.
# untouched. A name missing here is emitted literally and nginx won't start.
ENV NGINX_ENVSUBST_FILTER='API_UPSTREAM|NGINX_RESOLVER|AUTH_RATE_LIMIT|TRUSTED_PROXY_CIDR'
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80
