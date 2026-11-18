"""Build only when explicitly invoked by the developer/release pipeline."""
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
os.environ.setdefault('PYINSTALLER_CONFIG_DIR', str(root / 'build/pyinstaller-cache'))
subprocess.run([
    sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
    '--name', 'streamglass-engine', '--distpath', str(root / 'engine-dist'),
    '--paths', str(root), '--additional-hooks-dir', str(root / 'scripts/pyinstaller-hooks'),
    '--copy-metadata', 'mitmproxy', '--collect-all', 'mitmproxy', '--collect-all', 'mitmproxy_rs',
    '--collect-all', 'cryptography', '--collect-all', 'certifi',
    '--hidden-import', 'backend', str(root / 'scripts/engine_entry.py'),
], cwd=root, check=True)
