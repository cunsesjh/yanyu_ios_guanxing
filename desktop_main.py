"""Windowed PyInstaller entry point (no console or child webserver process)."""
import multiprocessing
import os
from pathlib import Path
import sys


if __name__ == '__main__':
    multiprocessing.freeze_support()
    if len(sys.argv) >= 6 and sys.argv[1] == '--apply-update':
        from desktop.updater import apply_update
        try:
            apply_update(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]))
        except Exception:
            sys.exit(1)
        sys.exit(0)
    update_confirmation = None
    if len(sys.argv) >= 4 and sys.argv[1] == '--confirm-update':
        update_confirmation = (sys.argv[2], sys.argv[3])
        del sys.argv[1:4]
    os.environ['YYJH_SKIP_LEGACY_MIGRATION'] = '1'
    if os.name == 'nt':
        from desktop.data_location import configured_data_root
        try:
            os.environ['YYJH_USER_DIR'] = str(configured_data_root())
        except OSError:
            # The GUI reports the unavailable configured location without silently
            # creating a second data set on C:.
            os.environ['YYJH_USER_DIR_ERROR'] = '1'
        if update_confirmation:
            os.environ['IOSGUANXING_UPDATE_MARKER'] = update_confirmation[0]
            os.environ['IOSGUANXING_UPDATE_STAGE'] = update_confirmation[1]
    from desktop.app import main
    sys.exit(main())
