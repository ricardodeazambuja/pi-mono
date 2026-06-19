# local-scripts (gitignored)

Personal tooling for running this repo as your global `pi`. Not part of the
project — this whole directory is gitignored.

## pi-local.sh

Switch the global `pi` between this local bleeding-edge repo and the published
npm package.

```sh
./local-scripts/pi-local.sh use        # build, then point global `pi` at this repo
./local-scripts/pi-local.sh update     # rebuild so the active local `pi` reflects current source
./local-scripts/pi-local.sh update --pull   # git pull --ff-only, then rebuild
./local-scripts/pi-local.sh npm        # revert global `pi` to the published npm package
./local-scripts/pi-local.sh npm 0.79.3 # revert to a specific published version
./local-scripts/pi-local.sh status     # show which `pi` is active (default subcommand)
```

Notes:
- `pi` is TypeScript, so source changes only take effect after a build —
  `update` (or `use`) runs `npm run build` for you.
- `use`/`update` build **before** touching the active install, so a broken
  build leaves your current `pi` untouched.
- All global paths are derived from `npm config get prefix`; nothing is
  hardcoded to a specific home layout.
- Verify a swap with `status` (or `readlink -f "$(command -v pi)"`) — the
  version string can't distinguish local from published when both are 0.79.3.

Convenience alias for your shell rc:

```sh
alias pi-local="$HOME/GitStuff/pi-mono/local-scripts/pi-local.sh"
```
