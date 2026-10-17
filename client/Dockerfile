FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS client_base
WORKDIR /app

# ARG is used to get the release id into the ENV from the command line, and then
# the ENV command makes the release id available to webpack to bundle the JS,
# which can make it available to sentry etc. Must be set before building.
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID

COPY package*.json .
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
