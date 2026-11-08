"""Exercise cancel, active deletion, fallback and last-record deletion in Qt."""
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication, QDialog, QMessageBox, QPushButton
from desktop.app import MainWindow
from desktop.storage import Store
from desktop.smoke import DATA

app = QApplication(sys.argv)
temporary = tempfile.TemporaryDirectory()
store = Store(temporary.name)
first = store.save_snapshot(DATA, 'ios', '1', '73576')
second = store.save_snapshot(DATA, 'ios', '1', '73580')
window = MainWindow(store, ROOT / 'web')
window.open_snapshot(second)
window.show()
failed = []

def exercise():
    dialog = next(d for d in window.findChildren(QDialog) if d.isVisible())
    try:
        button = dialog.findChild(QPushButton, 'deleteSnapshot')
        assert button is not None, 'missing delete button'
        with patch('desktop.app.QMessageBox.question', return_value=QMessageBox.No):
            button.click()
        assert len(store.list_snapshots()) == 2 and window.current['id'] == second['id'], 'cancel changed active snapshot'
        with patch('desktop.app.QMessageBox.question', return_value=QMessageBox.Yes):
            button.click()
        assert len(store.list_snapshots()) == 1 and window.current['id'] == first['id'], 'active deletion did not switch to remaining snapshot'
        assert store.selected()['id'] == first['id']
        with patch('desktop.app.QMessageBox.question', return_value=QMessageBox.Yes):
            button.click()
        assert not store.list_snapshots() and store.selected() is None
        assert window.current is None and window.stack.currentWidget() is window.welcome
        assert window.site.payload == b'' and not window.history_button.isEnabled()
        assert not button.isEnabled()
        assert len(list((store.root / '.deleted-snapshots').iterdir())) == 2
        print('PASS: deletion cancel, active snapshot fallback, last record clears embedded save, recoverable files', flush=True)
    except Exception as error:
        failed.append(str(error) or type(error).__name__)
        print('FAIL: ' + failed[-1], flush=True)
    finally:
        dialog.reject()

def start():
    QTimer.singleShot(300, exercise)
    window.show_history()
    window.close()
    app.exit(bool(failed))

QTimer.singleShot(1000, start)
sys.exit(app.exec())
