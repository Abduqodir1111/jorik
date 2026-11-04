#!/bin/sh
set -eu
command=${SSH_ORIGINAL_COMMAND:-}
case "$command" in
  'release '*) sha=${command#release } ;;
  *) echo 'Only Jorik release is allowed' >&2; exit 1 ;;
esac
[ "${#sha}" = 40 ] || exit 1
case "$sha" in *[!a-f0-9]*) exit 1;; esac
exec /usr/bin/sudo -n /usr/local/sbin/jorik-ci-deploy "$sha"
