#!/usr/bin/env bash
# Build the exact checkout on the host, or transfer CI images through SSH.
set -euo pipefail
source deploy/project.sh
: "${DEPLOY_PATH:?}" "${RUNTIME_ENV:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
[[ "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9/_-]+$ && "$DEPLOY_PATH" != / ]] || exit 1
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]] || exit 1
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || { echo 'Checkout must match deployment commit'; exit 1; }
delivery=${DELIVERY:-source}
[[ "$delivery" == source || "$delivery" == image ]] || exit 1
image_tag=${IMAGE_TAG:-sha-$GITHUB_SHA}
[[ "$image_tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || exit 1
release="$DEPLOY_PATH/releases/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$RUNTIME_ENV" > "$work/env.out"
images=()
for i in "${!image_vars[@]}"; do
  sed -i "/^${image_vars[$i]}=/d" "$work/env.out"
  image="$project-release:${services[$i]}-$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  images+=("$image")
  printf '\n%s=%s\n' "${image_vars[$i]}" "$image" >> "$work/env.out"
done
# Persistent API config must stay outside the per-release directory.
sed -i '/^DEPLOY_ROOT=/d' "$work/env.out"
printf '\nDEPLOY_ROOT=%s\n' "$DEPLOY_PATH" >> "$work/env.out"
DEPLOY_ENV_FILE="$work/env.out" docker compose --env-file "$work/env.out" -f docker-compose.prod.yml config -q
SECONDS=0
ssh target "umask 077; mkdir -p '$release'"
scp "$work/env.out" docker-compose.prod.yml deploy/activate.sh deploy/project.sh "target:$release/"
ssh target "set -eu; cd '$release'; mv env.out .env; chmod 600 .env; mv docker-compose.prod.yml docker-compose.yml"
if [[ "$project" == marketbot-api ]]; then
  ssh target "mkdir -p '$DEPLOY_PATH/config' '$release/nginx'"
  tar -C deploy/nginx -cf - . | ssh target "tar -C '$release/nginx' -xf -"
fi
if [[ "$delivery" == source ]]; then
  git archive --format=tar.gz --output="$work/source.tar.gz" "$GITHUB_SHA"
  scp "$work/source.tar.gz" "target:$release/"
  ssh target "set -eu; cd '$release'; mkdir source; tar -xzf source.tar.gz -C source; rm source.tar.gz"
  echo "Source transfer took ${SECONDS}s"
  SECONDS=0
  for i in "${!images[@]}"; do
    build_args=()
    if [[ "$project" == marketbot-miniapp && "${services[$i]}" == web ]]; then
      # Public build setting, never read from the runtime secret.
      [[ "${BOT_USERNAME:-}" =~ ^[a-zA-Z0-9_]*$ ]] || exit 1
      build_args+=(--build-arg "VITE_BOT_USERNAME=${BOT_USERNAME:-}")
    fi
    # Every forwarded argument is a validated path, generated tag, or username.
    ssh target "set -eu; cd '$release'; DOCKER_BUILDKIT=1 docker build ${build_args[*]} -f 'source/${dockerfiles[$i]}' -t '${images[$i]}' source; docker image inspect '${images[$i]}' >/dev/null"
  done
  ssh target "rm -rf '$release/source'"
  echo "Server build took ${SECONDS}s"
else
  repository="ghcr.io/${GITHUB_REPOSITORY,,}"
  [[ "$repository" =~ ^ghcr.io/[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || exit 1
  for i in "${!images[@]}"; do
    ref="$repository${image_suffixes[$i]}:$image_tag"
    docker pull --platform linux/amd64 "$ref"
    image_id=$(docker image inspect --format '{{.Id}}' "$ref")
    docker tag "$image_id" "${images[$i]}"
    DEPLOY_PATH="$DEPLOY_PATH" IMAGE="${images[$i]}" bash deploy/ship-images.sh
  done
  echo "Image preparation and transfer took ${SECONDS}s"
fi
# Sidecars are immutable pinned tags. Transfer only when absent, in either mode.
for image in "${sidecars[@]}"; do
  if ! ssh target "docker image inspect '$image' >/dev/null 2>&1"; then
    docker pull --platform linux/amd64 "$image"
    DEPLOY_PATH="$DEPLOY_PATH" IMAGE="$image" bash deploy/ship-images.sh
  fi
done
SECONDS=0
ssh target "cd '$release'; bash activate.sh"
echo "Release activation took ${SECONDS}s"
printf 'Deployed commit %s via %s\n' "$GITHUB_SHA" "$delivery"
