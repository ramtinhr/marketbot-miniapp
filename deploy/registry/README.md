# Deployment-server registry

This is an opt-in registry; existing SSH image delivery remains the default.
CI must be able to reach the registry endpoint before enabling it. Hosting the
registry in Iran does not itself provide a route from GitHub-hosted runners.

## Server setup

1. Point `registry.parscryptoexchange.com` at the deployment server. Add that
   hostname to the existing nginx ACME webroot configuration and issue a
   certificate using the server's existing certbot installation. Do not stop
   the production nginx or start another listener on ports 80/443.
2. Copy this directory to `/opt/marketbot-registry`, copy `.env.example` to
   `.env`, and set `REGISTRY_CERTIFICATES_DIR` to the host directory containing
   certbot's `live/` and `archive/` folders. The registry serves HTTPS on 5443,
   independently of nginx. Allow that TCP port for the CI runners.
3. Install `apache2-utils` if `htpasswd` is unavailable. Create credentials
   interactively (the password stays out of shell history):

   ```sh
   cd /opt/marketbot-registry
   install -d -m 700 auth
   htpasswd -Bc auth/htpasswd marketbot-ci
   chmod 600 auth/htpasswd
   docker compose up -d
   ```

   If the server cannot pull `registry:3`, pull it on a connected machine and
   transfer it using `docker save`, SSH/scp and `docker load` first.
4. Add `docker compose -f /opt/marketbot-registry/compose.yml --env-file
   /opt/marketbot-registry/.env restart registry` to the existing certificate
   renewal deploy hook. The registry must restart after certificate renewal.
5. Verify the endpoint from the CI network: unauthenticated
   `curl -i https://registry.parscryptoexchange.com:5443/v2/` must return 401.
   Then use `docker login registry.parscryptoexchange.com:5443` and verify a
   test image can be pushed and pulled.

## Enable in GitHub

Add repository Actions secrets `LOCAL_REG_USER` and `LOCAL_REG_PASS`. The
production environment needs access to these too. Add repository Actions
variable `LOCAL_REGISTRY=registry.parscryptoexchange.com:5443` (no URL scheme).
The variable must be visible to both CI and Deploy, not only production.

CI publishes server/web images to both GHCR and the new registry. Run CI on
main and wait for both pushes before deploying a tag from this registry;
older tags are not copied automatically. Deploy logs into the registry on
the server and explicitly pulls images before starting compose. Production's
`pull_policy: never` still prevents an extra implicit pull during startup.

Remove `LOCAL_REGISTRY` to return to GHCR plus SSH layer transfer. Do not run
`docker compose down -v` in this directory: it deletes stored registry images.
Monitor disk usage; image retention/garbage collection must be planned before
storage fills up. Credentials currently grant push and pull access to the
whole registry; do not share them outside trusted CI and deployment admins.

## Installed server (2026-11-07)

Registry endpoint: `registry.parscryptoexchange.com:5443` on `45.94.215.65`.
Configuration lives in `/opt/marketbot-registry`. Credentials are in
`/opt/marketbot-registry/credentials.json` (root-only, never commit this file).
The existing API certbot renews the certificate; a host cron job checks its
fingerprint every ten minutes and restarts the registry when it changes.
The server resolves the registry hostname to loopback in `/etc/hosts` so
production pulls stay on the machine. Public DNS must remain DNS-only.

The API nginx startup script and `templates/registry-acme.conf` serve the
HTTP challenge for renewals. Matching changes are prepared in the sibling
`marketbot-api/deploy/nginx` source directory; preserve these on API deploys.
Server/web `latest` images were seeded from fresh, unstarted containers of
the installed images because their side-loaded archives had missing blobs.
These seed images have flattened layers; subsequent CI builds publish normal
layered images. Production containers were not replaced during setup.
