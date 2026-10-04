#!/bin/sh
# Keep the repository's exact check script, but cap concurrent test files on a
# host shared by validation lanes. No test is skipped and no source is modified.
set -eu
REPOS_CHECK_NODE=$(command -v node)
export REPOS_CHECK_NODE
REPOS_CHECK_BIN=$(mktemp -d "${TMPDIR:-/tmp}/repos-check.XXXXXX")
trap 'rm -rf "$REPOS_CHECK_BIN"' EXIT HUP INT TERM
cat > "$REPOS_CHECK_BIN/node" <<'WRAPPER'
#!/bin/sh
if [ "${1-}" = "--test" ]; then
  shift
  exec "$REPOS_CHECK_NODE" --test --test-concurrency=2 "$@"
fi
exec "$REPOS_CHECK_NODE" "$@"
WRAPPER
chmod +x "$REPOS_CHECK_BIN/node"
PATH="$REPOS_CHECK_BIN:$PATH" npm run check
