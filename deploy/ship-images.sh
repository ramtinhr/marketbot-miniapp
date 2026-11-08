#!/usr/bin/env bash
# Images are pulled on the runner because production cannot reach the registry.
set -euo pipefail
: "${DEPLOY_PATH:?set DEPLOY_PATH}"
: "${IMAGE:?set IMAGE}"
# ssh joins remote arguments into shell text. Keep all forwarded values simple.
if [[ ! "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9_./-]+$ || "$DEPLOY_PATH" == / ]]; then
  echo 'DEPLOY_PATH must be an absolute path without spaces or shell characters' >&2
  exit 1
fi
for ref in "$IMAGE"; do
  if [[ ! "$ref" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$ ]]; then
    echo 'invalid image reference' >&2
    exit 1
  fi
done
umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/layers"
echo 'Saving images and preparing layers…'
docker save "$IMAGE" > "$work/images.tar"
tar -xf "$work/images.tar" -C "$work/layers"
bytes=$(du -sb "$work/layers" | cut -f1)

# Feed the script on stdin: `ssh … bash -c "multiline script"` loses quoting
# when SSH joins its arguments, leaving bash -c without its script argument.
mode=$(ssh target bash -seuo pipefail -- "$DEPLOY_PATH" "$bytes" <<'REMOTE'
  deploy_path=$1
  bytes=$2
  mkdir -p "$deploy_path"
  avail=$(df -B1 --output=avail "$deploy_path" | tail -1 | tr -d ' ')
  need=$((bytes * 2))
  if [ "$avail" -lt "$need" ]; then
    echo "server needs ~$need bytes free under $deploy_path (have $avail)" >&2
    df -h "$deploy_path" >&2
    exit 1
  fi
  if command -v rsync >/dev/null 2>&1; then
    mkdir -p -m 700 "$deploy_path/.image-cache"
    echo rsync
  else
    echo archive
  fi
REMOTE
)

if [[ "$mode" == rsync ]] && command -v rsync >/dev/null 2>&1; then
  echo 'Syncing changed image layers (unchanged content is reused)…'
  # Compare content, not Docker archive timestamps. Delay cache deletions until
  # transfer completes; partial files survive a dropped connection for retry.
  rsync -rzc --compress-level=1 --delete-delay \
    --partial --partial-dir=.rsync-partial --info=progress2 --stats --human-readable \
    -e 'ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10' \
    "$work/layers/" "target:$DEPLOY_PATH/.image-cache/"
  echo 'Loading images from the server layer cache…'
  ssh target bash -seuo pipefail -- "$DEPLOY_PATH" <<'REMOTE'
    tar -C "$1/.image-cache" --exclude='.rsync-partial' -cf - . | docker load
REMOTE
else
  echo 'rsync unavailable; transferring a full gzip archive (install rsync on both hosts to reuse layers).'
  gzip -1 < "$work/images.tar" > "$work/release-images.tar.gz"
  ls -lh "$work/release-images.tar.gz"
  # A failed upload cannot be mistaken for a complete archive on a later run.
  scp -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
    "$work/release-images.tar.gz" "target:$DEPLOY_PATH/release-images.tar.gz.part"
  ssh target bash -seuo pipefail -- "$DEPLOY_PATH" <<'REMOTE'
    archive="$1/release-images.tar.gz.part"
    gzip -dc "$archive" | docker load
    rm -f "$archive"
REMOTE
fi
