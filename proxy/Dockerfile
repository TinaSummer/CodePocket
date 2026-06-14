FROM oven/bun:1.3 AS runtime
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
EXPOSE 3010
ENV HAPI_HUB_URL=http://hapi-hub:3006
ENV PROXY_PORT=3010
CMD ["bun", "run", "src/index.ts"]
