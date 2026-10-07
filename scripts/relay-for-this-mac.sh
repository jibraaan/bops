#!/usr/bin/env bash
# For the dev app (npm run app:build), which bundles vendor/orgo-relay/orgo-relay-<arch> for this Mac.
# A checkout that fetched the relay before it was kept per arch has only vendor/orgo-relay/orgo-relay
# (this Mac's): that one is used. Without either, the app is built without a relay, as before.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/vendor/orgo-relay"
arch="$(node -p process.arch)"
if [ ! -e "$dir/orgo-relay-$arch" ] && [ -x "$dir/orgo-relay" ]; then
  cp "$dir/orgo-relay" "$dir/orgo-relay-$arch"
fi
