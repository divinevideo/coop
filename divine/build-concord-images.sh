#!/usr/bin/env bash
# Build/test only. The publisher defaults to verify and needs explicit run authorization.
set -euo pipefail
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
[[ ${BUILD_PLATFORM:-linux/amd64} == linux/amd64 ]] || { echo 'Source image contract requires linux/amd64.' >&2; exit 1; }
artifacts=${ARTIFACT_DIR:-${TMPDIR:-/tmp}/coop-source-artifacts-$revision}
python3 divine/concord-image-artifacts.py build --source "$PWD" --source-sha "$revision" --harness-sha "$revision" --artifacts "$artifacts"
for image in server worker; do
  docker run --rm --entrypoint sh "divine-local/coop-source-$image:$revision" -c 'test -r routes/concord/service.js && test -r routes/concord/index.js'
done
docker run --rm --entrypoint sh "divine-local/coop-source-client:$revision" -c 'test -r /usr/share/nginx/html/source-build.json && test -r /usr/share/nginx/html/index.html'
echo "PASS four source images and artifact manifest at $artifacts; no publication performed."
