"""Exercise real tar/gzip/rsync and SSH argument parsing, without Docker or a server."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('ship-images.sh').resolve()


class ShipImagesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.fixture = self.root / 'fixture'
        (self.fixture / 'blobs').mkdir(parents=True)
        (self.fixture / 'blobs/base').write_bytes(os.urandom(512 * 1024))
        (self.fixture / 'blobs/app').write_text('old-app')
        (self.fixture / 'manifest.json').write_text('old-manifest')
        self.deploy = self.root / 'target'
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        FIXTURE=str(self.fixture), LOADED=str(self.root / 'loaded'),
                        LOAD_LOG=str(self.root / 'loads'), DEPLOY_PATH=str(self.deploy),
                        IMAGE='ghcr.io/example/frontend:latest')
        self.mock('docker', '''#!/bin/bash
set -euo pipefail
case "$1" in
  save) tar -cf - -C "$FIXTURE" . ;;
  load) mkdir -p "$LOADED"; tar -xf - -C "$LOADED"; echo loaded >> "$LOAD_LOG" ;;
  *) exit 90 ;;
esac
''')
        # Real ssh also joins all arguments into a single remote shell command.
        # Executing that way catches the original `bash -c` quoting regression.
        self.mock('ssh', '''#!/usr/bin/env python3
import os, subprocess, sys
args = sys.argv[1:]
while args and args[0] == '-o': args = args[2:]
assert args.pop(0) == 'target'
if args[0] == 'bash' and os.environ.get('NO_REMOTE_RSYNC'):
    script = sys.stdin.read().replace('if command -v rsync >/dev/null 2>&1; then', 'if false; then')
    sys.exit(subprocess.run(['bash', '-c', ' '.join(args)], input=script, text=True).returncode)
if args[0] == 'rsync' and os.environ.get('FAIL_SYNC'):
    sys.exit(23)
os.execvp('bash', ['bash', '-c', ' '.join(args)])
''')
        self.mock('scp', '''#!/usr/bin/env python3
import shutil, sys
args = sys.argv[1:]
while args and args[0] == '-o': args = args[2:]
shutil.copyfile(args[0], args[1].removeprefix('target:'))
''')

    def mock(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_ship(self, **env):
        return subprocess.run(['bash', str(SCRIPT)], env={**self.env, **env},
                              text=True, capture_output=True, timeout=40)

    def assert_loaded(self, expected='old-app'):
        self.assertEqual((self.root / 'loaded/blobs/app').read_text(), expected)
        self.assertEqual((self.root / 'loaded/blobs/base').read_bytes(), (self.fixture / 'blobs/base').read_bytes())

    @unittest.skipUnless(shutil.which('rsync'), 'rsync is needed to test the incremental path')
    def test_changed_layers_only_and_cache_cleanup(self):
        (self.fixture / 'obsolete').write_text('old layer')
        first = self.run_ship()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assert_loaded()
        (self.fixture / 'obsolete').unlink()
        partial = self.deploy / '.image-cache/blobs/.rsync-partial'
        partial.mkdir()
        (partial / 'abandoned').write_text('incomplete old transfer')
        # Same length changes must still transfer: size/time checks are insufficient.
        (self.fixture / 'blobs/app').write_text('new-app')
        (self.fixture / 'manifest.json').write_text('new-manifest')
        second = self.run_ship()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('Number of regular files transferred: 2', second.stdout)
        self.assert_loaded('new-app')
        self.assertFalse((self.root / 'loaded/blobs/.rsync-partial').exists())
        self.assertFalse((self.deploy / '.image-cache/obsolete').exists())
        same = self.run_ship()
        self.assertEqual(same.returncode, 0, same.stderr)
        self.assertIn('Number of regular files transferred: 0', same.stdout)

    def test_archive_fallback_uses_stdin_script_and_cleans_upload(self):
        result = self.run_ship(NO_REMOTE_RSYNC='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('transferring a full gzip archive', result.stdout)
        self.assert_loaded()
        self.assertFalse((self.deploy / 'release-images.tar.gz.part').exists())

    @unittest.skipUnless(shutil.which('rsync'), 'rsync is needed to test an interrupted sync')
    def test_failed_transfer_never_loads_an_incomplete_cache(self):
        result = self.run_ship(FAIL_SYNC='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'loads').exists())
        retry = self.run_ship()
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assert_loaded()

    def test_insufficient_disk_space_stops_before_transfer(self):
        self.mock('df', '#!/bin/bash\nprintf "Avail\\n0\\n"\n')
        result = self.run_ship()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('bytes free', result.stderr)
        self.assertFalse((self.root / 'loads').exists())

    def test_remote_shell_metacharacters_are_rejected_before_transfer(self):
        result = self.run_ship(DEPLOY_PATH='/tmp/path;echo-unwanted')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.deploy.exists())


if __name__ == '__main__':
    unittest.main()
