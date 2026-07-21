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
# Probe with bun (always present in this image); wget/curl are not installed in
# oven/bun. Generous start-period covers migrations + optional seed on boot.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD printf "const r = await fetch('http://localhost:8787/health'); process.exit(r.ok ? 0 : 1)" | bun run -
CMD ["./start.sh"]
