# Divine unprivileged coop-client.
#
# Re-packages Roost's OFFICIAL coop-client static assets to serve under
# nginx-unprivileged (non-root, listens on 8080), so the client runs under
# Divine's restrictive K8s security context (readOnlyRootFilesystem + drop:[ALL]),
# where the stock-nginx official image (root, port 80) CrashLoops on chown.
#
# We do NOT rebuild the SPA from source — the official 1.0 client uses relative
# GraphQL URLs (roostorg/coop#455), so its built assets are environment-agnostic
# and we just re-serve them. Bump COOP_CLIENT_TAG to track upstream client releases
# (pin to the `1.0` semver tag once Roost cuts the release).
ARG COOP_CLIENT_TAG=latest
FROM ghcr.io/roostorg/coop-client:${COOP_CLIENT_TAG} AS official

FROM nginxinc/nginx-unprivileged:1.27-alpine
# Replace the base image's default server block with ours (port 8080 + SPA routing).
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=official /usr/share/nginx/html /usr/share/nginx/html
EXPOSE 8080
