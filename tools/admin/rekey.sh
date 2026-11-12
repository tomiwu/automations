#!/usr/bin/env bash
# One step to rotate CREDENTIAL_KEY. Run it on your own computer from the repo root:
#   bash tools/admin/rekey.sh
# It works the same from zsh or bash (macOS bash 3.2 is fine). It never prints a secret value.
#
# 1. Loads the gitignored .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FAMILY_ID,
#    the old CREDENTIAL_KEY and the credential values, each in a variable with the credential name).
# 2. Makes a new key. Encrypts every credential with it (value from .env, else the old stored value,
#    else it asks you), in one upsert. Sets the Librus origin where it is empty.
# 3. Writes the new key to .env (the old key stays in .env.bak) so all later steps use the SAME key.
# 4. Saves the new key in the config of every Kody package (./configure), then prints a per-name status.
# Set WITH_PAYMENTS=1 (in .env or before the command) after @tomiwu/payments-watch is on Kody. Then it also
#    saves the payments-watch Dashboard allowlist: PAYMENTS_DASHBOARD_USER (asked if missing) and
#    PAYMENTS_DASHBOARD_TOKEN (made and kept in .env if missing). Only the SHA-256 of the token goes to Kody.
# If a step fails, run the script again: it starts from the key that is now in .env.
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
[ -f .env ] || { echo "No .env in $(pwd)" >&2; exit 1; }

# Windows line ends in .env add a CR to each value; remove them before we load the file.
if grep -q $'\r' .env; then tr -d '\r' < .env > .env.tmp && mv .env.tmp .env && echo "Removed CR characters from .env"; fi
set -a; . ./.env; set +a

ask() { # ask NAME "description": read a missing plain setting and keep it in .env
  local name=$1 value
  if [ -z "${!name:-}" ]; then
    printf '%s (%s): ' "$name" "$2" >&2
    IFS= read -r value
    printf '%s=%q\n' "$name" "$value" >> .env
    export "$name=$value"
  fi
}
ask SUPABASE_URL "https://<ref>.supabase.co"
ask FAMILY_ID "the Family ID"
if [ "${WITH_PAYMENTS:-}" = "1" ]; then
  ask PAYMENTS_DASHBOARD_USER "the Dashboard user name"
  if [ -z "${PAYMENTS_DASHBOARD_TOKEN:-}" ]; then
    PAYMENTS_DASHBOARD_TOKEN=$(openssl rand -hex 24)
    printf 'PAYMENTS_DASHBOARD_TOKEN=%s\n' "$PAYMENTS_DASHBOARD_TOKEN" >> .env
    export PAYMENTS_DASHBOARD_TOKEN
  fi
  [ -n "${PAYMENTS_DASHBOARD_USER:-}" ] || { echo "PAYMENTS_DASHBOARD_USER is empty" >&2; exit 1; }
  [ -n "${PAYMENTS_DASHBOARD_TOKEN:-}" ] || { echo "PAYMENTS_DASHBOARD_TOKEN is empty" >&2; exit 1; }
fi
[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || { echo "Put SUPABASE_SERVICE_ROLE_KEY in .env first" >&2; exit 1; }

NEW_CREDENTIAL_KEY=$(openssl rand -base64 32 | tr -d '[:space:]')
export NEW_CREDENTIAL_KEY
ADMIN="node --experimental-strip-types tools/admin/src/cli.ts"

echo "== Encrypt the credentials with a new key =="
LOG=$(mktemp "${TMPDIR:-/tmp}/rekey.XXXXXX")
SNIPPET="$LOG.ts"
trap 'rm -f "$LOG" "$SNIPPET"' EXIT
status=0
$ADMIN rekey --family "$FAMILY_ID" | tee "$LOG" || status=1
if ! grep -q '^Encrypted ' "$LOG"; then
  echo "Nothing was stored. .env still has the old key. Fix the error above and run again." >&2
  exit 1
fi

# The stored rows now use the new key: keep it in .env so every later step uses the SAME key.
cp .env .env.bak
grep -v '^CREDENTIAL_KEY=' .env.bak > .env || true
printf 'CREDENTIAL_KEY=%s\n' "$NEW_CREDENTIAL_KEY" >> .env
echo "Saved the new CREDENTIAL_KEY in .env (old file: .env.bak)"

echo "== Save the key in the Kody packages =="
node --experimental-strip-types tools/admin/src/configure-snippet.ts > "$SNIPPET"
npx -y @kodycodes/cli@1.31.4 execute --file "$SNIPPET" || status=1

if [ "${WITH_PAYMENTS:-}" = "1" ]; then
  echo "Dashboard user: $PAYMENTS_DASHBOARD_USER"
  echo "Dashboard token: in .env (PAYMENTS_DASHBOARD_TOKEN)"
fi

echo "== Done =="
if [ "$status" -eq 0 ]; then echo "All credentials: ok"; else echo "Some steps are not ok (see above). Fix .env and run again."; fi
exit "$status"
