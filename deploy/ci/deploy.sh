#!/bin/sh
# Root-owned installation at /usr/local/sbin/jorik-ci-deploy.
set -eu
umask 077
[ "$(id -u)" = 0 ] && [ "$#" = 1 ] || exit 1
sha=$1
[ "${#sha}" = 40 ] || exit 1
case "$sha" in *[!a-f0-9]*) exit 1;; esac
base=/volume1/docker/jorik
work=/var/lib/jorik-ci
mkdir -p "$work"
# A second deploy must never overlap, even outside GitHub Actions.
mkdir "$work/lock" 2>/dev/null || { echo 'Deployment already active'; exit 1; }
archive="$work/release.tar.gz"
switched=0
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$result" != 0 ] && [ "$switched" = 1 ]; then
    cp "$backup/compose.yaml" "$base/compose.yaml"
    /usr/local/bin/docker-compose -p jorik -f "$base/compose.yaml" up -d --no-build --force-recreate jorik
    echo 'Rolled back application; current database retained. Backup:' "$backup"
  fi
  rm -f "$archive"
  rmdir "$work/lock"
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
python3 -c 'import sys
with open(sys.argv[1],"wb") as f:
 n=0
 while True:
  b=sys.stdin.buffer.read(1048576)
  if not b:break
  n+=len(b)
  if n>500*1024*1024:raise SystemExit("Release too large")
  f.write(b)' "$archive"
python3 - "$archive" "$sha" <<'PY'
import tarfile,json,sys
with tarfile.open(sys.argv[1]) as t:
 m=json.load(t.extractfile('manifest.json'))
 assert len(m)==1 and m[0]['RepoTags']==['jorik:git-'+sys.argv[2]]
 c=json.load(t.extractfile(m[0]['Config']))
 assert c['os']=='linux' and c['architecture']=='arm64'
 assert c['config']['Labels']['org.opencontainers.image.revision']==sys.argv[2]
PY
cd "$base"
stamp=$(date +%Y%m%d-%H%M%S)
backup="$base/backups/ci-$stamp-$sha"
mkdir -p "$backup"
cp -p compose.yaml "$backup/compose.yaml"
cp -p jorik.env "$backup/jorik.env"
old=$(/usr/local/bin/docker inspect --format '{{.Image}}' jorik)
/usr/local/bin/docker tag "$old" "jorik:rollback-ci-$stamp"
/usr/local/bin/docker load -i "$archive"
image="jorik:git-$sha"
[ "$(/usr/local/bin/docker image inspect --format '{{.Architecture}}' "$image")" = arm64 ]
python3 - "$image" "$work/compose.yaml" <<'PY'
import pathlib,re,sys
s=pathlib.Path('compose.yaml').read_text()
s,n=re.subn(r'(?m)^(\s+image:)\s*jorik:[^\s]+',lambda m:m[1]+' '+sys.argv[1],s)
assert n==1
pathlib.Path(sys.argv[2]).write_text(s)
PY
/usr/local/bin/docker stop jorik >/dev/null
switched=1
/usr/bin/sqlite3 data/real.sqlite ".backup $backup/real.sqlite"
cp "$work/compose.yaml" compose.yaml
/usr/local/bin/docker-compose -p jorik -f compose.yaml up -d --no-build --force-recreate jorik
attempt=0
until [ "$(/usr/local/bin/docker inspect --format '{{.State.Health.Status}}' jorik)" = healthy ]; do
 attempt=$((attempt+1)); [ "$attempt" -lt 45 ] || exit 1; sleep 2
done
/usr/local/bin/docker exec jorik node -e 'const D=require("better-sqlite3");const d=new D("/app/data/real.sqlite",{readonly:true});if(d.pragma("integrity_check",{simple:true})!=="ok")process.exit(1)'
/usr/bin/curl --fail --silent --show-error https://inbox.storebooks.uz/build-info.json | python3 -c 'import json,sys;assert json.load(sys.stdin)["revision"]==sys.argv[1]' "$sha"
printf '%s\n' "$sha" > "$work/current-revision"
switched=0
echo "JORIK_DEPLOY_OK revision=$sha backup=$backup"
