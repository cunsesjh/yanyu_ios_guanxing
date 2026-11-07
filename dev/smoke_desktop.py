"""Launch the same offline integration check used by the packaged EXE."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault('IOSGUANXING_SMOKE_REPORT', str(ROOT / 'build' / 'smoke.json'))
from desktop.app import main

if __name__ == '__main__':
    sys.exit(main())
