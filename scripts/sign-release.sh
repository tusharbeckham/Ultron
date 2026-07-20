#!/usr/bin/env sh
set -eu
FILE=${1:?Usage: scripts/sign-release.sh <archive>}
KEY=${ULTRON_GPG_KEY_ID:?Set ULTRON_GPG_KEY_ID to a user-controlled signing key}
command -v gpg >/dev/null 2>&1 || { echo 'gpg is required' >&2; exit 1; }
gpg --batch --yes --local-user "$KEY" --armor --detach-sign "$FILE"
gpg --verify "$FILE.asc" "$FILE"
printf 'Signed and verified %s\n' "$FILE"
