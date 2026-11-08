#!/usr/bin/env bash
# Run as root on the deployment server after DNS points at this machine.
set -euo pipefail
cd /opt/marketbot-registry
domain=registry.parscryptoexchange.com
getent ahostsv4 "$domain" >/dev/null
docker exec marketbot-api-certbot certbot certonly \
  --non-interactive --webroot -w /var/www/certbot \
  --cert-name "$domain" -d "$domain"
docker compose up -d
for attempt in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$domain:5443/v2/" || true)
  if [ "$code" = 401 ]; then break; fi
  sleep 2
done
test "$code" = 401
# Store Docker credentials in an ephemeral config rather than root's config.
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
python3 -c 'import json; print(json.load(open("credentials.json"))["password"], end="")' |
  docker login "$domain:5443" -u marketbot-ci --password-stdin
# Publish new images through CI. Optional one-time seeding for old side-loaded
# images is deliberately separate from registry activation.
echo 'Registry is ready. Configure GitHub secrets and LOCAL_REGISTRY before enabling CI.'
