#!/usr/bin/env bash
# Runs inside an uploaded release, with secrets kept out of the build context.
set -euo pipefail
umask 077
source ./project.sh
release=$(pwd)
root=$(dirname "$(dirname "$release")")
previous=$(readlink -f "$root/current" || true)
# Reuse the legacy Compose project so existing containers and volumes stay owned
# by the same stack. Otherwise Compose would derive a new name per release.
if [[ -f "$root/.compose-project" ]]; then
  project=$(cat "$root/.compose-project")
elif [[ -f "$root/docker-compose.yml" ]]; then
  existing=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$legacy_container" 2>/dev/null || true)
  project=${existing:-$(basename "$root")}
fi
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 1
printf '%s\n' "$project" > "$root/.compose-project"
compose() { docker compose --project-name "$project" --env-file .env -f docker-compose.yml "$@"; }
compose config -q
# Keep the old flat deployment usable for rollback during the first conversion.
if [[ ! -f "$previous/docker-compose.yml" && -f "$root/docker-compose.yml" && -f "$root/.env" ]]; then
  previous="$root/releases/legacy-$(basename "$release")"
  mkdir -p "$previous"
  cp "$root/docker-compose.yml" "$root/.env" "$previous/"
  if [[ -d "$root/nginx" ]]; then cp -a "$root/nginx" "$previous/"; fi
  if [[ -d "$root/config" ]]; then ln -s "$root/config" "$previous/config"; fi
  for i in "${!services[@]}"; do
    container=$(cd "$root"; compose ps -a -q "${services[$i]}")
    if [[ -n "$container" ]]; then
      image_id=$(docker inspect --format '{{.Image}}' "$container")
      old_image="$project-release:legacy-${services[$i]}-$(basename "$release")"
      docker tag "$image_id" "$old_image"
      sed -i "/^${image_vars[$i]}=/d" "$previous/.env"
      printf '\n%s=%s\n' "${image_vars[$i]}" "$old_image" >> "$previous/.env"
    fi
  done
fi
# These preflights run before any running service is replaced.
if [[ "$legacy_container" == marketbot-engine ]]; then
  topics=$(docker exec marketbot-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 --list)
  for topic in market.depth.v1 market.book.v1; do
    printf '%s\n' "$topics" | grep -qx "$topic" || { echo "Missing Kafka topic: $topic" >&2; exit 1; }
  done
fi
if [[ "$legacy_container" == marketbot-api ]]; then
  # Database migrations are not reversed by an application rollback.
  compose run --rm --no-deps api node src/migrate.js
fi
ready() {
  if ! compose up -d --remove-orphans --wait --wait-timeout 120; then return 1; fi
  # Confirm each application container uses the resolved local release image.
  for service in "${services[@]}"; do
    container=$(compose ps -a -q "$service") || return 1
    [[ -n "$container" ]] || return 1
    image_ref=$(compose config --images "$service") || return 1
    expected_id=$(docker image inspect --format '{{.Id}}' "$image_ref") || return 1
    running_id=$(docker inspect --format '{{.Image}}' "$container") || return 1
    if [[ "$running_id" != "$expected_id" ]]; then
      echo "Service $service runs $running_id, expected $expected_id" >&2
      return 1
    fi
  done
  case "$legacy_container" in
    marketbot-api)
      compose exec -T nginx nginx -t || return 1
      for attempt in {1..30}; do
        if compose exec -T api sh -c 'wget -q -O- "http://127.0.0.1:${PORT:-8080}/health/ready"' >/dev/null; then return 0; fi
        sleep 2
      done
      return 1 ;;
    marketbot-miniapp-server)
      for attempt in {1..30}; do
        if compose exec -T server sh -c 'wget -q -O- "http://127.0.0.1:${PORT:-8090}/health/ready"' >/dev/null \
          && compose exec -T web sh -c 'wget -q -O- "http://127.0.0.1:${WEB_PORT:-8082}/api/v1/market/symbols"' >/dev/null; then return 0; fi
        sleep 2
      done
      return 1 ;;
    marketbot-engine)
      # No HTTP endpoint: retain the existing no-restart observation window.
      sleep 20
      container=$(compose ps -a -q engine) || return 1
      [[ -n "$container" ]] || return 1
      state=$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$container") || return 1
      [[ "$state" == 'true 0' ]] || return 1 ;;
  esac
}
if ready; then
  ln -sfn "$release" "$root/current.next"
  mv -Tf "$root/current.next" "$root/current"
  compose ps
else
  echo 'Deployment startup/readiness failed; collecting diagnostics before rollback' >&2
  compose ps -a || true
  compose logs --tail 100 || true
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    docker inspect --format 'Container {{.Name}} state: {{json .State}}' "$container" || true
  done < <(compose ps -a -q || true)
  if [[ -n "$previous" && "$previous" != "$release" && -f "$previous/docker-compose.yml" ]]; then
    echo 'Restoring previous release'
    cd "$previous"
    if ready; then
      ln -sfn "$previous" "$root/current.next"
      mv -Tf "$root/current.next" "$root/current"
    else
      echo 'Previous release also failed readiness; manual intervention required' >&2
    fi
  else
    echo 'No previous release available; stopping failed first deployment'
    compose down || true
  fi
  exit 1
fi
