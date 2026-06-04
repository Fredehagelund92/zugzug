FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src
COPY start.sh ./
RUN chmod +x start.sh
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1
CMD ["./start.sh"]
