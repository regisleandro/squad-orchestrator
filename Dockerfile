FROM docker:29-cli AS docker-cli

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
# CLI atual para conversar com o daemon do host (o pacote Debian é antigo).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/ ./dist/
ENV PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "dist/index.js"]
