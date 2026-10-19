# Build this fork's tested UI; the upstream asset repackager cannot carry it.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
ARG BUILD_ID
COPY divine/coop-client-source/write-build-proof.mjs /tmp/write-build-proof.mjs
RUN npm run build && BUILD_ID="$BUILD_ID" node /tmp/write-build-proof.mjs
FROM nginxinc/nginx-unprivileged:1.27.5-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS source-client
ARG BUILD_ID
LABEL org.opencontainers.image.source="https://github.com/divinevideo/coop" org.opencontainers.image.revision=$BUILD_ID
COPY divine/coop-client-unprivileged/nginx.conf /etc/nginx/conf.d/default.conf
USER root
RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /app/build /usr/share/nginx/html
USER 101
EXPOSE 8080
