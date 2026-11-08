"""Exercise release preparation, readiness and rollback without a live server."""
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parent
SHA = 'a' * 40


class ReleaseTests(unittest.TestCase):
    def fixture(self, root):
        binary = root / 'bin'
        binary.mkdir()
        scripts = {
            'docker': r'''#!/bin/bash
printf '%s:docker %s\n' "$PWD" "$*" >> "$COMMAND_LOG"
if [[ "$*" == *'src/migrate.js'* && "$FAIL_STAGE" == migration ]]; then exit 42; fi
if [[ "$*" == *'up -d'* && "$PWD" == "$FAIL_RELEASE" ]]; then exit 42; fi
if [[ "$*" == *'exec -T'* && "$PWD" == "$UNREADY_RELEASE" ]]; then exit 42; fi
if [[ "$*" == *'ps -a -q'* ]]; then echo test-container; fi
if [[ "$*" == *'com.docker.compose.project'* ]]; then echo legacy-stack; fi
if [[ "$*" == *'{{.Image}}'* || "$*" == *'{{.Id}}'* ]]; then echo sha256:1234; fi
if [[ "$*" == *'config --images'* ]]; then echo example:release; fi
if [[ "$*" == *'{{.State.Running}} {{.RestartCount}}'* ]]; then
  if [[ "$PWD" == "$UNREADY_RELEASE" ]]; then echo 'false 2'; else echo 'true 0'; fi
fi
if [[ "$*" == *'kafka-topics.sh'* ]]; then printf 'market.depth.v1\nmarket.book.v1\n'; fi
''',
            'sleep': '#!/bin/bash\nexit 0\n',
            'git': r'''#!/bin/bash
if [[ "$1" == rev-parse ]]; then echo "$CHECKOUT"; else
  echo "git $*" >> "$COMMAND_LOG"
  for arg in "$@"; do
    if [[ "$arg" == --output=* ]]; then echo source > "${arg#--output=}"; fi
  done
fi
''',
            'scp': r'''#!/bin/bash
echo "scp $*" >> "$COMMAND_LOG"
for arg in "$@"; do
  if [[ "$arg" == */env.out ]]; then cat "$arg" > "$ENV_LOG"; fi
done
''',
            'ssh': r'''#!/bin/bash
echo "ssh $*" >> "$COMMAND_LOG"
if [[ -n "$FAIL_STAGE" && "$*" == *"$FAIL_STAGE"* ]]; then exit 42; fi
cat >/dev/null
''',
        }
        for name, script in scripts.items():
            path = binary / name
            path.write_text(script)
            path.chmod(0o755)
        return {
            **os.environ, 'PATH': f'{binary}:{os.environ["PATH"]}',
            'COMMAND_LOG': str(root / 'commands'), 'ENV_LOG': str(root / 'env-copy'),
            'FAIL_STAGE': '', 'FAIL_RELEASE': '', 'UNREADY_RELEASE': '', 'CHECKOUT': SHA,
        }

    def activate(self, *, fail=False, previous=False, legacy=False, unready=False, migration=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self.fixture(root)
            release = root / 'releases/new'
            release.mkdir(parents=True)
            shutil.copy(DEPLOY / 'project.sh', release)
            (release / 'docker-compose.yml').touch()
            (release / '.env').touch()
            old = root if legacy else root / 'releases/old'
            if previous or legacy:
                old.mkdir(exist_ok=True)
                (old / 'docker-compose.yml').touch()
                (old / '.env').touch()
                if previous:
                    (root / 'current').symlink_to(old)
                if legacy:
                    (root / 'config').mkdir()
                    (root / 'config/operator.json').write_text('preserved')
            env.update(FAIL_RELEASE=str(release) if fail else '',
                       UNREADY_RELEASE=str(release) if unready else '',
                       FAIL_STAGE='migration' if migration else '')
            result = subprocess.run(['bash', str(DEPLOY / 'activate.sh')], cwd=release,
                                    env=env, capture_output=True, text=True)
            commands = (root / 'commands').read_text()
            if migration and 'legacy_container=marketbot-api\n' in (DEPLOY / 'project.sh').read_text():
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(' up -d', commands)
                return
            failed = fail or (unready and 'legacy_container=marketbot-web\n' not in (DEPLOY / 'project.sh').read_text())
            self.assertEqual(result.returncode != 0, failed, result.stdout + result.stderr)
            if not failed:
                self.assertEqual((root / 'current').resolve(), release)
            else:
                self.assertIn('collecting diagnostics', result.stderr)
                self.assertIn('inspect --format Container', commands)
                if previous or legacy:
                    restored = root / 'releases/legacy-new' if legacy else old
                    self.assertEqual((root / 'current').resolve(), restored)
                    self.assertIn(f'{restored}:docker compose', commands)
                    self.assertNotIn(' down', commands)
                    if legacy:
                        self.assertIn('legacy-stack-release:legacy-', (restored / '.env').read_text())
                        self.assertEqual((restored / 'config/operator.json').read_text(), 'preserved')
                else:
                    self.assertFalse((root / 'current').exists())
                    self.assertLess(commands.index('inspect --format Container'), commands.index(' down'))

    def test_success(self):
        self.activate()

    def test_success_with_previous(self):
        self.activate(previous=True)

    def test_first_failure_collects_diagnostics_then_stops(self):
        self.activate(fail=True)

    def test_failure_restores_previous_but_remains_failed(self):
        self.activate(fail=True, previous=True)

    def test_failure_snapshots_and_restores_flat_deployment(self):
        self.activate(fail=True, legacy=True)

    def test_dependency_readiness_failure_rolls_back(self):
        self.activate(unready=True, previous=True)

    def test_failed_migration_does_not_replace_running_service(self):
        self.activate(migration=True, previous=True)

    def ship(self, delivery='source', fail='', checkout=SHA):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self.fixture(root)
            shutil.copytree(DEPLOY, root / 'deploy', ignore=shutil.ignore_patterns('__pycache__'))
            # Image transport has its own tests; record this integration boundary.
            (root / 'deploy/ship-images.sh').write_text('echo "transfer $IMAGE" >> "$COMMAND_LOG"\n')
            (root / 'docker-compose.prod.yml').touch()
            (root / 'deploy/nginx').mkdir(exist_ok=True)
            env.update(DEPLOY_PATH='/opt/test', RUNTIME_ENV='MARKETBOT_API_IMAGE=stale\nMARKETBOT_ENGINE_IMAGE=stale\nMARKETBOT_WEB_IMAGE=stale\nMINIAPP_SERVER_IMAGE=stale\nMINIAPP_WEB_IMAGE=stale\nREDIS_PASSWORD=example',
                       GITHUB_SHA=SHA, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='2',
                       GITHUB_REPOSITORY='Owner/Repo', DELIVERY=delivery, IMAGE_TAG='',
                       FAIL_STAGE=fail, CHECKOUT=checkout)
            result = subprocess.run(['bash', 'deploy/ship.sh'], cwd=root, env=env,
                                    capture_output=True, text=True)
            commands = (root / 'commands').read_text() if (root / 'commands').exists() else ''
            config = (root / 'env-copy').read_text() if (root / 'env-copy').exists() else ''
            return result, commands, config

    def test_source_builds_exact_commit_before_activation(self):
        result, commands, config = self.ship()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'.tar.gz {SHA}', commands)
        self.assertLess(commands.index('docker build'), commands.index('bash activate.sh'))
        line = next(line for line in (DEPLOY / 'project.sh').read_text().splitlines() if line.startswith('dockerfiles='))
        for dockerfile in shlex.split(line.removeprefix('dockerfiles=(').removesuffix(')')):
            self.assertIn(f"-f 'source/{dockerfile}'", commands)
        self.assertNotIn('docker pull', commands)
        self.assertNotIn('transfer ', commands)
        self.assertIn('DEPLOY_ROOT=/opt/test', config)
        self.assertIn(f'{SHA}-123-2', config)
        line = next(line for line in (DEPLOY / 'project.sh').read_text().splitlines() if line.startswith('image_vars='))
        for variable in shlex.split(line.removeprefix('image_vars=(').removesuffix(')')):
            self.assertNotIn(f'{variable}=stale', config)

    def test_image_mode_resolves_commit_and_transfers_unique_tag(self):
        result, commands, config = self.ship(delivery='image')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('docker pull --platform linux/amd64 ghcr.io/owner/repo', commands)
        self.assertIn(f':sha-{SHA}', commands)
        self.assertIn('transfer ', commands)
        self.assertNotIn('docker build', commands)
        self.assertLess(commands.index('transfer '), commands.index('bash activate.sh'))
        self.assertIn(f'{SHA}-123-2', config)

    def test_failed_preparation_never_activates(self):
        for stage in ('mkdir -p', 'tar -xzf', 'docker build'):
            with self.subTest(stage=stage):
                result, commands, _ = self.ship(fail=stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('bash activate.sh', commands)

    def test_wrong_checkout_never_contacts_host(self):
        result, commands, _ = self.ship(checkout='b' * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('ssh', commands)


if __name__ == '__main__':
    unittest.main()
