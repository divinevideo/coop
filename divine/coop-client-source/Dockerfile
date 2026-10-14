# Build this fork's tested UI; the upstream asset repackager cannot carry it.
FROM node:24.14.1-bullseye-slim@sha256:7016825698f5bfb8e9cb89d98d10a33e5796b19cc01ec4da131e9aa478f2cc0c AS build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build
FROM nginxinc/nginx-unprivileged:1.27.5-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
ARG BUILD_ID
LABEL org.opencontainers.image.source="https://github.com/divinevideo/coop" org.opencontainers.image.revision=$BUILD_ID
COPY divine/coop-client-unprivileged/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 8080
