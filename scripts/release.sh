#!/usr/bin/env bash
# Builds Bops.app for release: the orgo-relay agent, the production server (Next standalone) and
# the signed, notarized DMG + zip in dist-desktop/, one each for Apple silicon (arm64) and Intel
# (x64). See "Releasing the Mac app" in README.md.
#
# Signing uses a "Developer ID Application" certificate: from the keychain, or CSC_LINK (a .p12,
# path or base64) + CSC_KEY_PASSWORD, or CSC_NAME to pick one. Notarization runs when one of these
# is set: APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (recommended), or APPLE_ID +
# APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. Without a certificate it builds an unsigned app for
# testing on this Mac only.
#
# Usage: scripts/release.sh [extra electron-builder args, e.g. --dir]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

[ "$(uname -s)" = Darwin ] || { echo "Build the Mac app on a Mac." >&2; exit 1; }

# desktop/repo.json makes the app run `next dev` from this folder (npm run app:build); a release
# runs its own bundled server instead.
rm -f desktop/repo.json

# The architectures to build, as electron-builder names them: package.json's mac targets (both), or
# only those asked for with --arm64 / --x64 (which go on to electron-builder too).
arches=()
for a in "$@"; do
  case "$a" in --arm64) arches+=(arm64) ;; --x64) arches+=(x64) ;; esac
done
[ ${#arches[@]} -gt 0 ] || arches=(arm64 x64)

# 1. The orgo-relay agent for each, bundled as Contents/Resources/bin/orgo-relay.
for arch in "${arches[@]}"; do
  relay="vendor/orgo-relay/orgo-relay-$arch"
  if [ -x scripts/fetch-relay.sh ]; then
    scripts/fetch-relay.sh "" "$arch"
  fi
  [ -x "$relay" ] || { echo "Missing $relay (scripts/fetch-relay.sh puts it there)." >&2; exit 1; }
  want="$([ "$arch" = x64 ] && echo x86_64 || echo arm64)"
  file "$relay" | grep -q "$want" || { echo "$relay is not an $want Mac binary." >&2; exit 1; }
done

# 2. The server. Keys stay out of the app: .env files are never bundled.
npx next build
rm -f .next/standalone/.env*
rm -rf .next/standalone/.data
[ -f .next/standalone/server.js ] || { echo "No .next/standalone/server.js: is output \"standalone\" set in next.config.ts?" >&2; exit 1; }
# No secret from the .env files next build reads may end up in what ships (only the setting names
# are printed). Settings named like secrets are checked (plain URLs and names would match the code's
# own defaults), written as KEY=v, KEY="v", KEY='v' or with `export ` in front.
leaked=""
for envfile in .env .env.local .env.production .env.production.local; do
  [ -f "$envfile" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ "$(tr '[:lower:]' '[:upper:]' <<<"$key")" =~ (KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|DATABASE_URL) ]] || continue
    value="${value%"${value##*[![:space:]]}"}"
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
    [ "${#value}" -ge 12 ] || continue
    if grep -rqsF -- "$value" .next/standalone .next/static public; then leaked="$leaked $key ($envfile)"; fi
  done < "$envfile"
done
[ -z "$leaked" ] || { echo "Values of these settings are in the build output:$leaked. Not shipping." >&2; exit 1; }

# 3. Signing and notarization.
signing=""
if [ -n "${CSC_LINK:-}" ] || security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  signing=1
  # electron-builder falls back to any certificate (an Apple Development one, a teammate's) when it
  # finds no Developer ID: pin the lookup to the Developer ID one, by its hash, unless CSC_NAME or
  # CSC_LINK picks one. (The check after the build fails if anything else signed the app.)
  if [ -z "${CSC_LINK:-}" ] && [ -z "${CSC_NAME:-}" ]; then
    CSC_NAME="$(security find-identity -v -p codesigning | awk '/"Developer ID Application: /{print $2; exit}')"
    export CSC_NAME
  fi
  if [ -z "${APPLE_API_KEY:-}${APPLE_ID:-}${APPLE_KEYCHAIN_PROFILE:-}" ]; then
    echo "Signing with Developer ID, but no notarization credentials are set (APPLE_API_KEY, APPLE_API_KEY_ID," >&2
    echo "APPLE_API_ISSUER). The app will be signed but not notarized: Gatekeeper will block it on other Macs." >&2
  fi
else
  cat >&2 <<'EOF'
No "Developer ID Application" certificate found (in the keychain or CSC_LINK).
Building UNSIGNED, for testing on this Mac only:
  - other Macs block it (Gatekeeper), and it can't be notarized;
  - macOS ties Screen Recording and Microphone grants to the signature, so each unsigned build
    may ask again.
To ship, install the Developer ID Application certificate of the Apple Developer team (or set
CSC_LINK and CSC_KEY_PASSWORD) and the notarization settings, then run this again.
EOF
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

# 4. The app. Resources/server is the standalone server (electron-builder never copies a top-level
# node_modules folder, so package.json copies .next/standalone/node_modules on its own).
npx electron-builder --mac "$@"

# Where electron-builder puts each arch's app.
app_of() { [ "$1" = x64 ] && echo "$root/dist-desktop/mac/Bops.app" || echo "$root/dist-desktop/mac-$1/Bops.app"; }

# 5. Smoke test: the bundled server starts with the app's own Node and serves the app and its state
# without a missing file. It runs as a fresh install does: no keys (env -i drops this shell's), an
# empty HOME, so it can't reach this Mac's Keychain, Orgo sign-in or Codex, and a spare port, so it
# doesn't meet a running Bops. The Intel app runs under Rosetta on Apple silicon; without Rosetta
# it's left out (it still gets the signature check).
smoke_test() {
  local app="$1" smoke smoke_pid ok="" code route
  smoke="$(mktemp -d)"
  for f in "$app/Contents/Resources/server/"* "$app/Contents/Resources/server/.next"; do ln -s "$f" "$smoke/"; done
  (cd "$smoke" && exec env -i HOME="$smoke" PATH=/usr/bin:/bin:/usr/sbin:/sbin ELECTRON_RUN_AS_NODE=1 NODE_ENV=production \
    PORT=3299 HOSTNAME=127.0.0.1 BOPS_SERVER_JS="$app/Contents/Resources/server/server.js" \
    "$app/Contents/MacOS/Bops" -e "process.chdir = () => {}; require(process.env.BOPS_SERVER_JS)" > "$smoke/server.log" 2>&1) &
  smoke_pid=$!
  for _ in $(seq 1 60); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3299/api/health)" = 200 ]; then ok=1; break; fi
    sleep 1
  done
  # The page and the app's state must answer too, with no key set (the window loads both first).
  if [ -n "$ok" ]; then
    for route in / /api/state; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:3299$route")"
      [ "$code" = 200 ] || { echo "$route answered $code without keys." >&2; ok=""; }
    done
  fi
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  if [ -z "$ok" ] || grep -qE "Cannot find module|MODULE_NOT_FOUND|ENOENT" "$smoke/server.log"; then
    echo "The bundled server in $app failed its smoke test; its log:" >&2
    sed -n 1,40p "$smoke/server.log" >&2
    exit 1
  fi
  rm -rf "$smoke"
  echo "Bundled server smoke test passed ($app)."
}

for arch in "${arches[@]}"; do
  app="$(app_of "$arch")"
  [ -d "$app" ] || { echo "No $app: electron-builder didn't build $arch." >&2; exit 1; }
  if [ "$arch" = arm64 ] && [ "$(uname -m)" != arm64 ]; then
    echo "This is an Intel Mac, which can't run the Apple silicon app: its server isn't smoke tested here." >&2
  elif [ "$arch" = x64 ] && [ "$(uname -m)" = arm64 ] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    echo "Rosetta isn't installed, so the Intel app's server isn't smoke tested (softwareupdate --install-rosetta)." >&2
  else
    smoke_test "$app"
  fi

  # -dvv: plain -dv never prints the Authority lines. Read into a variable first: with pipefail, grep -q
  # stopping at the first match makes codesign fail on the closed pipe, and the check with it.
  signature="$(codesign -dvv "$app" 2>&1 || true)"
  if [[ "$signature" == *"Authority=Developer ID Application"* ]]; then
    codesign --verify --deep --strict "$app" && echo "Signature OK ($arch)."
    spctl -a -vv -t exec "$app" 2>&1 || echo "Gatekeeper doesn't accept the $arch app yet (not notarized?)." >&2
  elif [ -n "$signing" ]; then
    echo "The $arch Bops.app isn't signed with a Developer ID Application certificate:" >&2
    grep Authority <<<"$signature" >&2 || echo "  (not signed)" >&2
    exit 1
  fi
done
ls -lh dist-desktop/*.dmg dist-desktop/*.zip 2>/dev/null || true
