#!/usr/bin/env bash
#
# pi-local.sh — switch the global `pi` between this local bleeding-edge repo and
# the published npm package, and rebuild the local copy.
#
# Subcommands:
#   use      Build this repo, then point global `pi` at it (symlink swap).
#   npm [v]  Revert global `pi` to the published npm package (optional version v).
#   update   Rebuild this repo so the active local `pi` reflects current source.
#            Pass --pull to `git pull --ff-only` first.
#   status   Show which `pi` is active (local fork vs npm) and its version.
#
# This file is gitignored — it is personal tooling, not part of the project.

set -euo pipefail

PKG_NAME="@earendil-works/pi-coding-agent"

# Canonical repo root = parent of this script's dir (pwd -P resolves symlinks,
# so this works even though ~/GitStuff is a symlink to ~/backup/GitStuff).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
LOCAL_PKG="$REPO_ROOT/packages/coding-agent"

# Derive global npm locations dynamically (no hardcoded ~/.npm-global).
PREFIX="$(npm config get prefix)"
GLOBAL_PKG="$PREFIX/lib/node_modules/$PKG_NAME"
GLOBAL_BIN="$PREFIX/bin/pi"

c_green() { printf '\033[32m%s\033[0m\n' "$1"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
c_red() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

active_target() {
	command -v pi >/dev/null 2>&1 || { echo "(pi not found)"; return; }
	readlink -f "$(command -v pi)"
}

is_local_active() {
	case "$(active_target)" in
		"$REPO_ROOT"/*) return 0 ;;
		*) return 1 ;;
	esac
}

verify() {
	local target; target="$(active_target)"
	echo "  pi        -> $(command -v pi 2>/dev/null || echo '(none)')"
	echo "  resolves  -> $target"
	echo "  version   -> $(pi --version 2>/dev/null || echo '?')"
	if is_local_active; then
		c_green "  => LOCAL fork active ($REPO_ROOT)"
	else
		c_yellow "  => npm/published pi active (not the local fork)"
	fi
}

build() {
	c_yellow "Building $REPO_ROOT (npm run build)…"
	( cd "$REPO_ROOT" && npm run build )
}

cmd_use() {
	# Build FIRST as a gate: a broken build aborts here, leaving the current pi
	# untouched instead of stranded.
	build
	[ -x "$LOCAL_PKG/dist/cli.js" ] || { c_red "Build did not produce $LOCAL_PKG/dist/cli.js"; exit 1; }

	c_yellow "Swapping global $PKG_NAME -> local repo…"
	mkdir -p "$(dirname "$GLOBAL_PKG")"
	rm -rf "$GLOBAL_PKG"
	ln -s "$LOCAL_PKG" "$GLOBAL_PKG"

	# Ensure the bin symlink exists and chains through the package dir.
	ln -sfn "../lib/node_modules/$PKG_NAME/dist/cli.js" "$GLOBAL_BIN"

	echo
	verify
}

cmd_npm() {
	local version="${1:-}"
	c_yellow "Reverting global $PKG_NAME to published npm package…"
	rm -rf "$GLOBAL_PKG"
	if [ -n "$version" ]; then
		npm install -g "${PKG_NAME}@${version}"
	else
		npm install -g "$PKG_NAME"
	fi
	echo
	verify
}

cmd_update() {
	local pull=0
	[ "${1:-}" = "--pull" ] && pull=1
	if [ "$pull" = 1 ]; then
		c_yellow "git pull --ff-only…"
		( cd "$REPO_ROOT" && git pull --ff-only )
	fi
	if ! is_local_active; then
		c_yellow "Note: the local fork is not the active pi. Rebuilding anyway; run '$0 use' to activate it."
	fi
	build
	echo
	verify
}

cmd_status() { verify; }

main() {
	local sub="${1:-status}"; shift || true
	case "$sub" in
		use) cmd_use "$@" ;;
		npm) cmd_npm "$@" ;;
		update) cmd_update "$@" ;;
		status) cmd_status "$@" ;;
		-h | --help | help)
			# Print only the leading header comment block (skip shebang, stop at first code line).
			awk 'NR==1 && /^#!/ {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "${BASH_SOURCE[0]}"
			;;
		*) c_red "Unknown subcommand: $sub"; c_red "Try: $0 --help"; exit 2 ;;
	esac
}

main "$@"
