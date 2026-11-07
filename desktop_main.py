"""Windowed PyInstaller entry point (no console or child webserver process)."""
import multiprocessing
import os
from pathlib import Path
import sys


if __name__ == '__main__':
    multiprocessing.freeze_support()
    os.environ['YYJH_SKIP_LEGACY_MIGRATION'] = '1'
    if os.name == 'nt':
        os.environ['YYJH_USER_DIR'] = str(Path(os.environ['LOCALAPPDATA']) / 'iosGuanxing')
    from desktop.app import main
    sys.exit(main())
