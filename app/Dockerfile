FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:1-alpine AS runtime
# server:8787 is the compose service name; override for other topologies.
ENV API_UPSTREAM=server:8787
# Only substitute API_UPSTREAM — leave $host/$http_upgrade/etc. untouched.
ENV NGINX_ENVSUBST_FILTER=API_UPSTREAM
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80
