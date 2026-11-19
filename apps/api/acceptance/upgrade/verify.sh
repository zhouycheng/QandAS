#!/bin/sh
# Compile the acceptance fixture and its HTTP client against the deployed release.
set -eu
root=$(git rev-parse --show-toplevel)
revision=09715715815de64ee299e287791abaf1006705ba
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
git -C "$root" archive "$revision" apps/api packages > "$workspace/source.tar"
tar -xf "$workspace/source.tar" -C "$workspace"
cd "$workspace/apps/api"
cp "$root/apps/api/acceptance/upgrade/ReleaseUpgradeTest.kt" src/test/kotlin/qanda/backend/
# Put the old fixture's DB and Prometheus on the same isolated network as the candidate roles.
python3 - <<'PY'
from pathlib import Path
p = Path('src/test/kotlin/qanda/backend/PostgresFixture.kt')
s = p.read_text()
for before, after in [
    ('withDatabaseName("qanda_backend")', 'withNetwork(queueNetwork);withNetworkAliases("upgrade-db");withDatabaseName("qanda_backend")'),
    ('withNetwork(queueNetwork);withExposedPorts(9090)', 'withNetwork(queueNetwork);withNetworkAliases("upgrade-prom");withExposedPorts(9090)')
]:
    assert s.count(before) == 1
    s = s.replace(before, after)
p.write_text(s)
PY
QANDA_RELEASED_REVISION="$revision" QANDA_CANDIDATE_ROOT="$root" ./mvnw -Dtest=NoSuchTest -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=ReleaseUpgradeTest verify
evidence="$root/apps/api/.backend-runtime/verification"
mkdir -p "$evidence"
cp target/release-upgrade.json "$evidence/release-upgrade.json"
