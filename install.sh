#!/usr/bin/env bash
# Sets up Mailtrap and installs the omp email bridge. See README.md.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
	echo "The installer needs Bun (https://bun.sh). Install it with: curl -fsSL https://bun.sh/install | bash" >&2
	exit 1
fi
if ! command -v omp >/dev/null 2>&1; then
	echo "Note: omp is not on your PATH. The extension is installed anyway and loads once omp runs." >&2
fi

exec bun scripts/install.ts "$@"
