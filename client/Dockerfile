FROM node:24.14.1-bullseye-slim AS client_base
WORKDIR /app

# ARG is used to get the release id into the ENV from the command line, and then
# the ENV command makes the release id available to webpack to bundle the JS,
# which can make it available to sentry etc. Must be set before building.
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID

COPY package*.json .
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
