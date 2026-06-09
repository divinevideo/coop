# Divine unprivileged coop-client.
#
# Re-packages Roost's OFFICIAL coop-client static assets to serve under
# nginx-unprivileged (non-root, listens on 8080), so the client runs under
# Divine's restrictive K8s security context (readOnlyRootFilesystem + drop:[ALL]),
# where the stock-nginx official image (root, port 80) CrashLoops on chown.
#
# We do NOT rebuild the SPA from source - the official 1.0 client uses relative
# GraphQL URLs (roostorg/coop#455), so its built assets are environment-agnostic
# and we just re-serve them. Bump COOP_CLIENT_DIGEST to track upstream client
# releases until Roost publishes a stable semver image tag.
ARG COOP_CLIENT_DIGEST=sha256:f6a228358975dd78615592ffe5116cd6ee0ac2d0beb9685622c43e642f24f104
FROM ghcr.io/roostorg/coop-client@${COOP_CLIENT_DIGEST} AS official

FROM nginxinc/nginx-unprivileged:1.27.5-alpine
# Replace the base image's default server block with ours (port 8080 + SPA routing).
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=official /usr/share/nginx/html /usr/share/nginx/html
EXPOSE 8080
