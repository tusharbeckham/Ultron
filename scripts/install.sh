#!/usr/bin/env sh
set -eu
PREFIX="${PREFIX:-$HOME/.local}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$PREFIX/lib/ultron-cli" "$PREFIX/bin"
cp -R "$ROOT"/. "$PREFIX/lib/ultron-cli/"
ln -sf "$PREFIX/lib/ultron-cli/bin/ultron.mjs" "$PREFIX/bin/ultron"
printf 'Installed Ultron CLI to %s/bin/ultron\n' "$PREFIX"
