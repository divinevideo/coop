#!/usr/bin/env bash
# Build only: no push, deployment, credentials, or environment mutation.
set -euo pipefail
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'Commit tracked changes before building release images.' >&2; exit 1; }
: "${COOP_IMAGE_PREFIX:=divine-coop-reviewed}"
for target in server worker_runner migrator; do
  image="$COOP_IMAGE_PREFIX/$target:$revision"
  docker buildx build --platform linux/amd64 --load --target "build_$target" --build-arg "BUILD_ID=$revision" --label "org.opencontainers.image.revision=$revision" --label org.opencontainers.image.source=https://github.com/divinevideo/coop -t "$image" .
  if [[ "$target" == migrator ]]; then
    docker run --rm --entrypoint sh "$image" -c 'test -r db/src/scripts/api-server-pg/2026.10.14T00.00.00.add_concord_receipts.sql'
  else
    docker run --rm --entrypoint sh "$image" -c 'test -r routes/concord/service.js && test -r routes/concord/index.js'
  fi
done
docker buildx build --platform linux/amd64 --load --build-arg "BUILD_ID=$revision" -f divine/coop-client-source/Dockerfile -t "$COOP_IMAGE_PREFIX/client:$revision" .
docker run --rm --entrypoint sh "$COOP_IMAGE_PREFIX/client:$revision" -c 'test -r /usr/share/nginx/html/index.html && grep -rq "Room enforcement" /usr/share/nginx/html/assets'
echo "PASS four source images built at $revision; deployment remains a separate gate."
