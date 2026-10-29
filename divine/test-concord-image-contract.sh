#!/usr/bin/env bash
# No Docker daemon, services, registry, credentials or third-party test dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 divine/test-concord-image-artifacts.py
python3 - <<'PY'
from pathlib import Path
client = Path('divine/coop-client-source/Dockerfile').read_text()
assert 'COPY client/ ./' in client
assert 'AS source-client' in client
assert 'npm run build' in client and 'write-build-proof.mjs' in client
assert 'COPY --from=build /app/build /usr/share/nginx/html' in client
assert 'BUILD_ID' in client and 'org.opencontainers.image.revision' in client
assert 'roostorg/coop-client' not in client
source = Path('Dockerfile').read_text()
for target in ['build_server', 'build_worker_runner', 'build_migrator']:
    assert 'AS ' + target in source
print('PASS source Dockerfile contracts; source UI acceptance remains a separate release check')
PY
