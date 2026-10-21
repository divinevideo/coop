# This is a fairly-standard multi-stage Dockerfile. We build 
# backend in a Node image, and then we copy the built files
# (but not the devDependencies [like typescript, etc.] or the raw source
# files) to final images that we'll actually run. This makes the final image a
# bit lighter and more secure. When building the backend, we always
# copy in package.json and package-lock.json first, as a distinct layer, so that
# Docker's cache will let us skip installs when the dependencies haven't changed.
# We build on debian because it has fewer dependency issues than Alpine for our
# native modules, and we don't really care about the larger image size.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS server_base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY ["server/package.json", "server/package-lock.json", "./"]
RUN npm ci
COPY ["server", "./"]

FROM server_base AS build_backend
RUN npm run build

# make a shared layer that can be the base for worker and api images.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS backend_base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*
COPY --from=build_backend ["/app/package.json", "/app/package-lock.json", "./"]
RUN npm ci --omit=dev
COPY --from=build_backend /app/transpiled ./

# See https://github.com/Yelp/dumb-init
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# ARG is used to get the release id into the ENV from the command line, and then
# the ENV command exposes the release id to the API app at runtime for logging.
# We put this after npm installs so it doesn't invalidate cache of prior steps,
# as it always changes.
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID

# Expose 8080 because the backend will run on this port absent a
# process.env.PORT to the contrary.
FROM backend_base AS build_server
EXPOSE 8080
CMD ["node", "bin/www.js"]

FROM backend_base AS build_worker_runner
CMD ["node", "bin/run-worker-or-job.js"]

# Compile the migration CLI and copy the append-only scripts before pruning.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS build_migration_runtime
WORKDIR /app/db
COPY ["db/package.json", "db/package-lock.json", "./"]
RUN npm ci
COPY ["db/src", "./src/"]
COPY ["db/tsconfig.json", "./"]
RUN npm run build && npm prune --omit=dev

# Installed runtime only. Existing npm run db:* overrides resolve compiled JS
# from the db package; no root development scripts or startup installs are used.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS build_migrator
WORKDIR /app/db
RUN groupadd -r migrator && useradd -r -g migrator -u 1001 migrator
ENV NPM_CONFIG_CACHE=/tmp/.npm
COPY --from=build_migration_runtime --chown=migrator:migrator /app/db/package.json ./
COPY --from=build_migration_runtime --chown=migrator:migrator /app/db/build ./build
COPY --from=build_migration_runtime --chown=migrator:migrator /app/db/node_modules ./node_modules
USER 1001
CMD ["node", "build/index.js", "apply", "--help"]
