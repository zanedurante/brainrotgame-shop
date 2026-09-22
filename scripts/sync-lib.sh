#!/usr/bin/env bash
# Copy directories to the server. Uses rsync when it is installed; otherwise streams a tar archive over
# ssh, which works from a plain Git for Windows install (no rsync there). Same helper as the games use.
#
#   sync_push SRC/ HOST:DEST/ [exclude ...]   mirror SRC into DEST; stale files in DEST are removed,
#                                             excluded names are neither sent nor removed (like rsync --delete)

sync_push() {
  local src=$1 dest=$2; shift 2
  if command -v rsync >/dev/null 2>&1; then
    local args=(); local e; for e in "$@"; do args+=(--exclude "$e"); done
    rsync -az --delete "${args[@]}" "$src" "$dest"; return
  fi
  local host=${dest%%:*} path=${dest#*:}
  local tar_ex=() keep="" e
  for e in "$@"; do tar_ex+=("--exclude=$e"); keep+=" ! -name '$e'"; done
  tar -C "$src" -czf - "${tar_ex[@]}" . | ssh "$host" "mkdir -p '$path' && find '$path' -mindepth 1 -maxdepth 1 $keep -exec rm -rf {} + && tar -C '$path' -xzf -"
}
