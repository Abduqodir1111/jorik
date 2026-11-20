#!/bin/sh
set -eu
# Only the dedicated Jorik data mount is writable. The app runs as node.
if [ "$(id -u)" = "0" ]; then
  owner="$(id -u node):$(id -g node)"
  marker=/app/data/.jorik-permissions-v1
  if [ "${JORIK_REPAIR_DATA_OWNERSHIP:-0}" = 1 ] ||
     [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$owner" ] ||
     [ "$(stat -c '%u:%g' /app/data)" != "$owner" ]; then
    # One initial repair, without following links or crossing other mounts.
    find /app/data -xdev ! -type l \( ! -uid "$(id -u node)" -o ! -gid "$(id -g node)" \) -exec chown -h "$owner" {} +
    temporary=$(mktemp /app/data/.jorik-permissions.XXXXXX)
    printf '%s\n' "$owner" > "$temporary"
    chmod 600 "$temporary"
    chown "$owner" "$temporary"
    mv -f "$temporary" "$marker"
  fi
  # Backup tools can recreate these individual files as root. Repair just them;
  # attachments created by the application already belong to node.
  for file in /app/data/attachments /app/data/real.sqlite /app/data/real.sqlite-wal /app/data/real.sqlite-shm /app/data/demo.sqlite /app/data/demo.sqlite-wal /app/data/demo.sqlite-shm /app/data/vapid.json; do
    if [ -e "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%u:%g' "$file")" != "$owner" ]; then
      chown -h "$owner" "$file"
    fi
  done
  exec gosu node "$@"
fi
exec "$@"
