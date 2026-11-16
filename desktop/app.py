"""Native Qt shell. The bundled simulator stays inside a private WebEngine page."""
import os
from pathlib import Path
import sys

from PySide6.QtCore import Qt, QThread, Signal, QUrl, QTimer, QStandardPaths
from PySide6.QtGui import QColor, QDesktopServices, QFont, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (QApplication, QDialog, QFileDialog, QFrame, QHBoxLayout,
                              QLabel, QListWidget, QListWidgetItem, QMainWindow,
                              QMessageBox, QProgressBar, QPushButton, QStackedWidget,
                              QVBoxLayout, QWidget)
from PySide6.QtWebEngineCore import (QWebEnginePage, QWebEngineProfile,
                                    QWebEngineUrlRequestInterceptor, QWebEngineSettings)
from PySide6.QtWebEngineWidgets import QWebEngineView

from . import RELEASE_CHANNEL, VERSION
from .server import LocalSite
from .release_notes import ITEMS as RELEASE_NOTE_ITEMS, TITLE as RELEASE_NOTE_TITLE
from .service import DownloadService
from .storage import Store
from .update import check_update


STYLE = '''
QMainWindow, QDialog { background: #0c111b; color: #e6edf6; }
QWidget { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; color: #dce5f3; }
QFrame#sidebar { background: #111925; border-right: 1px solid #243145; }
QLabel#brand { font-size: 21px; font-weight: 700; color: #f5f8ff; }
QLabel#eyebrow { color: #67dbc1; font-size: 11px; font-weight: 700; }
QLabel#muted { color: #91a2ba; }
QLabel#supportedVersions { background: #151f2e; color: #a9bdd5; border: 1px solid #263850;
                           border-radius: 7px; padding: 8px; font-size: 12px; }
QLabel#author { background: #193c40; color: #b7f6e5; border: 1px solid #4a9f8c;
                border-radius: 10px; padding: 12px 8px; font-family: "Microsoft YaHei", "Segoe UI";
                font-size: 13px; font-weight: 700; line-height: 1.6; }
QLabel#headline { font-size: 30px; font-weight: 700; color: #f4f7fd; }
QLabel#pageTitle { font-size: 18px; font-weight: 600; }
QLabel#drop { border: 1px dashed #3a526d; border-radius: 14px; background: #151f2e;
              color: #a5bad2; padding: 28px; font-size: 14px; }
QPushButton { background: #1a2739; border: 1px solid #2b3c53; border-radius: 8px;
              padding: 10px 15px; text-align: left; }
QPushButton:hover { background: #23354d; border-color: #557596; }
QPushButton:disabled { color: #5e718a; background: #142031; border-color: #213047; }
QPushButton#primary { background: #68dbc0; color: #09241e; border: 0; font-weight: 700; }
QPushButton#primary:hover { background: #8ae9d2; }
QPushButton#primary:disabled { background: #345b53; color: #93b8af; }
QPushButton#nav { background: #1d3d46; border: 1px solid #2d665f; padding: 11px 14px; color: #b6f3e3; }
QPushButton#nav:hover { background: #28545a; color: #f0fff9; }
QPushButton#nav:disabled { background: #182b32; color: #6d9a91; border-color: #29454a; }
QFrame#header { background: #101824; border-bottom: 1px solid #243145; }
QFrame#status { background: #152236; border-top: 1px solid #283c54; }
QLabel#error { color: #ffb4a6; }
QListWidget { background: #121d2c; border: 1px solid #2d4059; border-radius: 8px; padding: 6px; }
QListWidget::item { padding: 16px 12px; border-bottom: 1px solid #213047; }
QListWidget::item:selected { background: #264655; color: #a5f2df; }
QProgressBar { border: 0; background: #182b3c; max-height: 3px; }
QProgressBar::chunk { background: #68dbc0; }
'''

LIGHT_STYLE = '''
QMainWindow, QDialog { background: #f3f6fb; color: #202d40; }
QWidget { color: #202d40; }
QFrame#sidebar, QFrame#header { background: #ffffff; border-color: #d4deeb; }
QFrame#status { background: #e9eff7; border-color: #d4deeb; }
QLabel#brand, QLabel#headline { color: #1c2b40; }
QLabel#muted { color: #596d86; }
QLabel#supportedVersions { background: #f1f5fa; color: #50657e; border-color: #cbd7e5; }
QLabel#author { background: #e0f4ec; color: #105d4b; border-color: #71b49e; }
QLabel#eyebrow { color: #147b69; }
QLabel#drop { background: #f4f7fc; color: #4b627d; border-color: #9cacc0; }
QPushButton { background: #eef3fa; color: #253a54; border-color: #cdd9e8; }
QPushButton:hover { background: #e3ecf8; border-color: #8ea7c8; }
QPushButton:disabled { background: #edf1f6; color: #8898ab; border-color: #dce3ec; }
QPushButton#primary { background: #168470; color: #ffffff; }
QPushButton#primary:hover { background: #106d5b; }
QPushButton#primary:disabled { background: #d7e7e2; color: #76988f; }
QPushButton#nav { background: #e0f3ed; color: #116956; border-color: #96cbbb; }
QPushButton#nav:hover { background: #cdeade; color: #0c5845; }
QLabel#error { color: #b5332a; }
QListWidget { background: #ffffff; color: #202d40; border-color: #cdd9e8; }
QListWidget::item { border-color: #dce3ec; }
QListWidget::item:selected { background: #d9eee8; color: #116956; }
QProgressBar { background: #dce7f1; }
QProgressBar::chunk { background: #168470; }
'''


def app_icon():
    root = Path(sys._MEIPASS) if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[1]
    image = root / 'assets' / 'iosGuanxing.png'
    if image.is_file():
        return QIcon(str(image))
    pix = QPixmap(128, 128)
    pix.fill(Qt.transparent)
    painter = QPainter(pix)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.setBrush(QColor('#142c3b'))
    painter.setPen(Qt.NoPen)
    painter.drawRoundedRect(4, 4, 120, 120, 28, 28)
    painter.setPen(QColor('#78e1c7'))
    painter.setFont(QFont('Segoe UI', 60, QFont.Bold))
    painter.drawText(pix.rect(), Qt.AlignCenter, 'G')
    painter.end()
    return QIcon(pix)


class LocalRequests(QWebEngineUrlRequestInterceptor):
    def __init__(self, site, parent):
        super().__init__(parent)
        self.site = site

    def interceptRequest(self, info):
        url = info.requestUrl()
        if url.scheme() in ('data', 'blob', 'about', 'qrc'):
            return
        if (url.scheme() == 'http' and url.host() == '127.0.0.1'
                and url.port() == self.site.httpd.server_port
                and url.path().startswith(self.site.prefix)):
            return
        info.block(True)


class LocalPage(QWebEnginePage):
    def __init__(self, profile, site, parent):
        super().__init__(profile, parent)
        self.site = site

    def acceptNavigationRequest(self, url, kind, main_frame):
        if url.scheme() == 'about':
            return True
        local = (url.scheme() == 'http' and url.host() == '127.0.0.1'
                 and url.port() == self.site.httpd.server_port
                 and url.path().startswith(self.site.prefix))
        if local:
            return True
        if kind == QWebEnginePage.NavigationTypeLinkClicked and url.scheme() in ('https', 'http'):
            QDesktopServices.openUrl(url)
        return False


class DownloadThread(QThread):
    progress = Signal(str)
    completed = Signal(object)
    failed = Signal(str)

    def __init__(self, store, session=None, har=None):
        super().__init__()
        self.store, self.session, self.har = store, session, har

    def run(self):
        try:
            if self.har:
                result = DownloadService(self.store).download_from_har(
                    self.har, self.progress.emit)
            else:
                result = DownloadService(self.store).download(
                    self.session, self.progress.emit)
            self.completed.emit(result)
        except (ValueError, OSError, RuntimeError) as error:
            # Domain errors are user-readable. Never expose headers, raw responses,
            # account IDs, tracebacks, or OS file paths in the GUI.
            message = str(error) if isinstance(error, ValueError) else '文件读取或保存失败，请检查文件和磁盘权限。'
            self.failed.emit(message)
        except Exception:
            self.failed.emit('下载或解码未完成，请重新导入 HAR 后重试。之前的存档已保留。')


class UpdateThread(QThread):
    completed = Signal(object)
    failed = Signal(str)

    def run(self):
        try:
            self.completed.emit(check_update(VERSION))
        except (RuntimeError, ValueError) as error:
            self.failed.emit(str(error))


class Welcome(QWidget):
    fileDropped = Signal(str)

    def __init__(self, select_file):
        super().__init__()
        self.setAcceptDrops(True)
        outer = QHBoxLayout(self)
        outer.setContentsMargins(60, 40, 60, 40)
        card = QWidget()
        card.setMinimumWidth(500)
        card.setMaximumWidth(660)
        layout = QVBoxLayout(card)
        layout.setSpacing(18)
        eyebrow = QLabel('YOUR SAVE. YOUR GALAXY.')
        eyebrow.setObjectName('eyebrow')
        layout.addWidget(eyebrow)
        title = QLabel('江湖进度，一窗掌握。')
        title.setObjectName('headline')
        layout.addWidget(title)
        text = QLabel('导入一次 HAR，连接你的云存档。\n下载完成后，在这个窗口里开始观星。')
        text.setObjectName('muted')
        text.setStyleSheet('font-size: 16px; line-height: 1.6;')
        layout.addWidget(text)
        layout.addSpacing(12)
        drop = QLabel('将 .har 文件拖到这里\n\n或点击下方按钮选择文件')
        drop.setObjectName('drop')
        drop.setAlignment(Qt.AlignCenter)
        layout.addWidget(drop)
        button = QPushButton('选择 HAR 并下载云存档  →')
        button.setObjectName('primary')
        button.setMinimumHeight(48)
        button.clicked.connect(select_file)
        self.select_button = button
        layout.addWidget(button)
        note = QLabel('会使用 HAR 中的登录会话向游戏服务器发起一次下载。\n'
                      '只读取服务器已保存的进度，不上传或覆盖游戏存档。\n'
                      '会话失效时重新导入；已下载的存档始终可以离线查看。')
        note.setObjectName('muted')
        note.setWordWrap(True)
        layout.addWidget(note)
        outer.addStretch()
        outer.addWidget(card)
        outer.addStretch()

    def dragEnterEvent(self, event):
        urls = event.mimeData().urls()
        if len(urls) == 1 and urls[0].isLocalFile() and urls[0].toLocalFile().lower().endswith('.har'):
            event.acceptProposedAction()

    def dropEvent(self, event):
        urls = event.mimeData().urls()
        if len(urls) == 1 and urls[0].isLocalFile() and urls[0].toLocalFile().lower().endswith('.har'):
            self.fileDropped.emit(urls[0].toLocalFile())
            event.acceptProposedAction()


class MainWindow(QMainWindow):
    def __init__(self, store, web_root):
        super().__init__()
        self.store = store
        self.session = None
        self.current = None
        self.worker = None
        self.update_worker = None
        self.update_check_automatic = False
        self.auto_update_prompted = False
        self.closing_after_download = False
        self.setAcceptDrops(True)
        self.setWindowTitle('iosGuanxing')
        self.setWindowIcon(app_icon())
        self.resize(1380, 900)
        self.setMinimumSize(1000, 680)
        self.site = LocalSite(web_root)
        self.setStyleSheet(STYLE)
        root = QWidget()
        self.setCentralWidget(root)
        main = QHBoxLayout(root)
        main.setSpacing(0)
        main.setContentsMargins(0, 0, 0, 0)

        side = QFrame()
        side.setObjectName('sidebar')
        side.setFixedWidth(220)
        sidebar = QVBoxLayout(side)
        sidebar.setContentsMargins(20, 28, 20, 22)
        sidebar.setSpacing(10)
        mark = QLabel('iosGuanxing')
        mark.setObjectName('brand')
        mark.setStyleSheet('font-size: 18px;')
        sidebar.addWidget(mark)
        label = QLabel('烟雨观星 · Windows 桌面版')
        label.setObjectName('muted')
        sidebar.addWidget(label)
        sidebar.addSpacing(25)
        self.home_button = self.button('观星主页', self.go_home, 'nav')
        sidebar.addWidget(self.home_button)
        self.refresh_button = self.button('↓  下载最新云存档', self.refresh, 'primary')
        sidebar.addWidget(self.refresh_button)
        self.import_button = self.button('＋  导入 / 更换 HAR', self.select_file)
        sidebar.addWidget(self.import_button)
        self.history_button = self.button('◷  历史存档', self.show_history)
        sidebar.addWidget(self.history_button)
        sidebar.addSpacing(16)
        self.session_label = QLabel('尚未导入登录会话')
        self.session_label.setTextFormat(Qt.PlainText)
        self.session_label.setObjectName('muted')
        self.session_label.setWordWrap(True)
        sidebar.addWidget(self.session_label)
        supported = QLabel('当前支持版本\n国服 73576 · 先行服 73580\n国际服 73680')
        supported.setTextFormat(Qt.PlainText)
        supported.setObjectName('supportedVersions')
        supported.setWordWrap(True)
        sidebar.addWidget(supported)
        sidebar.addStretch()
        author = QLabel('作者：B站 / 贴吧 / 抖音\n辣笔小勋    欢迎关注')
        author.setObjectName('author')
        author.setAlignment(Qt.AlignCenter)
        sidebar.addWidget(author)
        self.theme_button = self.button('☀  切换浅色模式', self.toggle_theme)
        sidebar.addWidget(self.theme_button)
        footer = QLabel('本地解码 · 内置观星\n\nv' + VERSION + '  /  ' + RELEASE_CHANNEL)
        footer.setObjectName('muted')
        sidebar.addWidget(footer)
        self.update_button = self.button('↻  检查更新', self.check_for_updates)
        sidebar.addWidget(self.update_button)
        main.addWidget(side)

        content = QVBoxLayout()
        content.setSpacing(0)
        header = QFrame()
        header.setObjectName('header')
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(25, 16, 25, 16)
        self.page_title = QLabel('开始观星')
        self.page_title.setTextFormat(Qt.PlainText)
        self.page_title.setObjectName('pageTitle')
        header_layout.addWidget(self.page_title)
        header_layout.addStretch()
        self.back_button = self.button('← 返回', lambda: self.view.back())
        header_layout.addWidget(self.back_button)
        content.addWidget(header)
        self.stack = QStackedWidget()
        self.welcome = Welcome(self.select_file)
        self.welcome.fileDropped.connect(self.start_download)
        self.stack.addWidget(self.welcome)
        self.view = QWebEngineView()
        # Off-the-record browser: saves stay in explicit snapshots, not a second
        # persistent Chromium profile. Re-import the selected snapshot on restart.
        self.profile = QWebEngineProfile(self)
        self.profile.setHttpCacheType(QWebEngineProfile.MemoryHttpCache)
        self.interceptor = LocalRequests(self.site, self.profile)
        self.profile.setUrlRequestInterceptor(self.interceptor)
        self.page = LocalPage(self.profile, self.site, self.view)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, False)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, False)
        self.view.setPage(self.page)
        self.view.setContextMenuPolicy(Qt.NoContextMenu)
        self.view.loadFinished.connect(self.page_loaded)
        self.view.urlChanged.connect(lambda url: self.back_button.setEnabled(self.view.history().canGoBack()))
        self.view.renderProcessTerminated.connect(self.page_crashed)
        self.profile.downloadRequested.connect(self.export_file)
        self.stack.addWidget(self.view)
        content.addWidget(self.stack, 1)

        status = QFrame()
        status.setObjectName('status')
        bottom = QVBoxLayout(status)
        bottom.setContentsMargins(22, 10, 22, 10)
        self.status_label = QLabel('准备就绪 · 首次使用请选择 HAR 文件')
        self.status_label.setTextFormat(Qt.PlainText)
        self.status_label.setWordWrap(True)
        bottom.addWidget(self.status_label)
        self.progress = QProgressBar()
        self.progress.setRange(0, 0)
        self.progress.setTextVisible(False)
        self.progress.hide()
        bottom.addWidget(self.progress)
        content.addWidget(status)
        main.addLayout(content, 1)
        self.apply_theme(self.store.theme())
        self.update_buttons()
        QTimer.singleShot(0, self.restore)
        if not (os.environ.get('IOSGUANXING_SMOKE_REPORT')
                or os.environ.get('IOSGUANXING_DISABLE_AUTO_UPDATE')):
            QTimer.singleShot(900, self.run_startup_prompts)

    def button(self, text, handler, object_name=''):
        button = QPushButton(text)
        button.setObjectName(object_name)
        button.clicked.connect(handler)
        return button

    def restore(self):
        message = ''
        try:
            self.session = self.store.load_session()
        except (OSError, RuntimeError, ValueError):
            message = '保存的会话无法读取，请重新导入 HAR；历史存档仍可查看。'
        row = self.store.selected()
        if row:
            try:
                self.open_snapshot(row)
            except (OSError, ValueError):
                message = '上次存档无法读取，请选择其他历史存档或重新导入 HAR。'
        if message:
            self.show_status(message, True)
        self.update_buttons()

    def show_status(self, text, error=False):
        self.status_label.setText(text)
        self.status_label.setStyleSheet('color: #ffb4a6;' if error else 'color: #a9c4d8;')

    def show_release_notes_once(self):
        if self.store.release_notes_seen(VERSION) or not RELEASE_NOTE_ITEMS:
            return
        dialog = QDialog(self)
        dialog.setWindowTitle('iosGuanxing 已更新')
        dialog.setModal(True)
        dialog.setMinimumWidth(500)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(28, 24, 28, 24)
        layout.setSpacing(14)

        version = QLabel('v%s  更新内容' % VERSION)
        version.setObjectName('eyebrow')
        layout.addWidget(version)
        title = QLabel(RELEASE_NOTE_TITLE)
        title.setObjectName('pageTitle')
        title.setWordWrap(True)
        layout.addWidget(title)
        for text in RELEASE_NOTE_ITEMS:
            item = QLabel('•  ' + text)
            item.setObjectName('muted')
            item.setWordWrap(True)
            item.setTextFormat(Qt.PlainText)
            layout.addWidget(item)
        layout.addSpacing(4)
        confirm = QPushButton('我知道了')
        confirm.setObjectName('primary')
        confirm.setMinimumHeight(42)
        confirm.clicked.connect(dialog.accept)
        layout.addWidget(confirm)
        dialog.exec()
        self.store.mark_release_notes_seen(VERSION)

    def run_startup_prompts(self):
        self.show_release_notes_once()
        # The release notes dialog owns the event loop while visible. Start the
        # network update check only after it closes, never as a nested dialog.
        QTimer.singleShot(1500, self.check_for_updates_automatically)

    def update_buttons(self):
        busy = self.worker is not None
        self.refresh_button.setEnabled(not busy and self.session is not None)
        self.import_button.setEnabled(not busy)
        self.history_button.setEnabled(not busy and bool(self.store.list_snapshots()))
        self.welcome.select_button.setEnabled(not busy)
        self.home_button.setEnabled(self.current is not None)
        self.back_button.setEnabled(self.view.history().canGoBack())
        self.update_button.setEnabled(self.update_worker is None)
        if self.session:
            platform = 'iOS' if self.session['platform'] == 'ios' else 'Android'
            self.session_label.setText('当前下载会话\n%s · %s 区\n有效期由游戏服务器决定' % (platform, self.session['area']))
        else:
            self.session_label.setText('尚未导入登录会话\n导入 HAR 后可手动刷新')

    def select_file(self):
        if self.worker:
            return
        path, _ = QFileDialog.getOpenFileName(self, '选择 ProxyPin HAR 文件', '', 'HAR 文件 (*.har)')
        if path:
            self.start_download(path)

    def dragEnterEvent(self, event):
        urls = event.mimeData().urls()
        if (not self.worker and len(urls) == 1 and urls[0].isLocalFile()
                and urls[0].toLocalFile().lower().endswith('.har')):
            event.acceptProposedAction()

    def dropEvent(self, event):
        urls = event.mimeData().urls()
        if (not self.worker and len(urls) == 1 and urls[0].isLocalFile()
                and urls[0].toLocalFile().lower().endswith('.har')):
            self.start_download(urls[0].toLocalFile())
            event.acceptProposedAction()

    def refresh(self):
        if self.session:
            self.start_download()

    def start_download(self, har=None):
        if self.worker or (not har and not self.session):
            return
        if har and not str(har).lower().endswith('.har'):
            self.show_status('请选择 .har 格式的抓包文件。', True)
            return
        self.worker = DownloadThread(self.store, self.session, har)
        self.worker.progress.connect(self.show_status)
        self.worker.completed.connect(self.download_complete)
        self.worker.failed.connect(self.download_failed)
        self.worker.finished.connect(self.download_finished)
        self.progress.show()
        self.show_status('开始下载当前云存档…')
        self.update_buttons()
        self.worker.start()

    def download_complete(self, result):
        self.session = result['session']
        try:
            self.open_snapshot(result['row'])
            self.show_status(result['warning'] or '下载成功 · 完整存档已保存，正在载入观星主页')
        except (OSError, ValueError):
            self.show_status('下载已保存，但页面载入失败。请从历史存档重新打开。', True)

    def download_failed(self, message):
        if '会话已失效' in message:
            self.session = None
        self.show_status(message + '  原有存档已保留。', True)

    def download_finished(self):
        worker = self.worker
        self.worker = None
        worker.deleteLater()
        self.progress.hide()
        self.update_buttons()
        if self.closing_after_download:
            self.close()

    def open_snapshot(self, row):
        data = self.store.load_snapshot(row['id'])
        self.site.set_snapshot(data, row['platform'])
        self.store.select(row['id'])
        self.current = row
        self.page_title.setText('%s  ·  %s 区' % (row['nick'], row['area']))
        self.stack.setCurrentWidget(self.view)
        self.view.setUrl(QUrl(self.site.url + '?snapshot=' + row['id']))
        self.update_buttons()

    def go_home(self):
        if self.current:
            self.stack.setCurrentWidget(self.view)
            self.view.setUrl(QUrl(self.site.url + '?snapshot=' + self.current['id']))

    def page_loaded(self, success):
        if success:
            self.page.runJavaScript('document.documentElement.dataset.theme="%s"' % self.site.theme)
        if not success:
            self.show_status('内置页面未能载入。请点击“观星主页”重试；本地存档已保留。', True)

    def toggle_theme(self):
        theme = 'light' if self.site.theme == 'dark' else 'dark'
        self.store.set_theme(theme)
        self.apply_theme(theme)

    def check_for_updates_automatically(self):
        if not self.auto_update_prompted:
            self.check_for_updates(True)

    def check_for_updates(self, automatic=False):
        if self.update_worker:
            return
        self.update_check_automatic = bool(automatic)
        self.update_worker = UpdateThread(self)
        self.update_worker.completed.connect(self.update_check_complete)
        self.update_worker.failed.connect(self.update_check_failed)
        self.update_worker.finished.connect(self.update_check_finished)
        if not self.update_check_automatic:
            self.update_button.setText('↻  正在检查…')
            self.show_status('正在检查 iosGuanxing 更新…')
        self.update_buttons()
        self.update_worker.start()

    def update_check_complete(self, result):
        if not result['available']:
            if not self.update_check_automatic:
                QMessageBox.information(self, '检查更新', '当前已是最新版本 v%s。' % VERSION)
                self.show_status('当前已是最新版本 v%s' % VERSION)
            return
        if self.update_check_automatic:
            if self.auto_update_prompted:
                return
            self.auto_update_prompted = True
        detail = ('发现新版本 v%s。\n\n%s\n\n请选择下载页面：'
                  % (result['version'], result['body'] or '请前往发布页面查看更新说明。'))
        dialog = QMessageBox(self)
        dialog.setWindowTitle('发现新版本')
        dialog.setText(detail)
        github = dialog.addButton('前往 GitHub', QMessageBox.ActionRole)
        gitee = dialog.addButton('前往 Gitee', QMessageBox.ActionRole)
        dialog.addButton('取消', QMessageBox.RejectRole)
        dialog.exec()
        if dialog.clickedButton() == github:
            QDesktopServices.openUrl(QUrl(result['github_url']))
        elif dialog.clickedButton() == gitee:
            QDesktopServices.openUrl(QUrl(result['gitee_url']))
        self.show_status('发现新版本 v%s' % result['version'])

    def update_check_failed(self, message):
        if not self.update_check_automatic:
            QMessageBox.warning(self, '检查更新失败', message)
            self.show_status(message, True)

    def update_check_finished(self):
        worker = self.update_worker
        self.update_worker = None
        if worker:
            worker.deleteLater()
        self.update_check_automatic = False
        self.update_button.setText('↻  检查更新')
        self.update_buttons()

    def apply_theme(self, theme):
        self.site.theme = theme
        self.setStyleSheet(STYLE + (LIGHT_STYLE if theme == 'light' else ''))
        self.theme_button.setText('☾  切换深色模式' if theme == 'light' else '☀  切换浅色模式')
        self.page.setBackgroundColor(QColor('#f3f6fb' if theme == 'light' else '#0c111b'))
        self.page.runJavaScript('document.documentElement.dataset.theme="%s"' % theme)

    def page_crashed(self, status, code):
        self.show_status('内置网页进程已停止，点击“观星主页”重新载入。', True)

    def show_history(self):
        rows = self.store.list_snapshots()
        if not rows:
            return
        dialog = QDialog(self)
        dialog.setWindowTitle('历史存档 · iosGuanxing')
        dialog.resize(660, 470)
        layout = QVBoxLayout(dialog)
        title = QLabel('选择已下载的存档')
        title.setObjectName('pageTitle')
        layout.addWidget(title)
        note = QLabel('打开历史存档不会联网；“下载最新”使用侧栏显示的当前会话。')
        note.setObjectName('muted')
        layout.addWidget(note)
        items = QListWidget()
        for row in rows:
            item = QListWidgetItem('%s  ·  %s 区  ·  v%s\n%s  /  %s 个字段' %
                                   (row['nick'], row['area'], row['version'],
                                    row['downloaded_at'].replace('T', ' '), row['fields']))
            items.addItem(item)
        items.setCurrentRow(next((i for i, row in enumerate(rows)
                                  if self.current and row['id'] == self.current['id']), 0))
        layout.addWidget(items)
        button = self.button('打开选中存档', dialog.accept, 'primary')
        buttons = QHBoxLayout()
        buttons.addWidget(button)
        remove = self.button('删除选中存档', lambda: delete_selected())
        remove.setObjectName('deleteSnapshot')
        buttons.addWidget(remove)
        layout.addLayout(buttons)

        def delete_selected():
            index = items.currentRow()
            if index < 0 or index >= len(rows):
                return
            row = rows[index]
            answer = QMessageBox.question(dialog, '删除本地历史存档',
                '删除「%s · %s 区 · %s」？\n仅移除这份本地记录，不影响游戏云存档或登录会话。' %
                (row['nick'], row['area'], row['downloaded_at'].replace('T', ' ')),
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
            if answer != QMessageBox.Yes:
                return
            try:
                self.store.delete_snapshot(row['id'])
            except (OSError, ValueError) as error:
                QMessageBox.warning(dialog, '删除失败', str(error))
                return
            rows.pop(index)
            items.takeItem(index)
            items.setCurrentRow(min(index, len(rows) - 1))
            button.setEnabled(bool(rows))
            remove.setEnabled(bool(rows))
            if self.current and self.current['id'] == row['id']:
                self.current = None
                self.view.stop()
                self.view.setUrl(QUrl('about:blank'))
                with self.site.lock:
                    self.site.payload = b''
                self.stack.setCurrentWidget(self.welcome)
                self.page_title.setText('欢迎使用 iosGuanxing')
                remaining = self.store.selected()
                if remaining:
                    try:
                        self.open_snapshot(remaining)
                    except (OSError, ValueError):
                        pass
            self.update_buttons()
            self.show_status('已删除本地历史记录 · 文件已移至本地回收目录，可恢复')

        items.itemDoubleClicked.connect(lambda item: dialog.accept())
        if dialog.exec() == QDialog.Accepted and items.currentRow() >= 0:
            try:
                self.open_snapshot(rows[items.currentRow()])
                self.show_status('已打开历史存档 · 离线查看')
            except (OSError, ValueError):
                self.show_status('这份存档无法读取，请选择其他历史记录。', True)

    def export_file(self, download):
        path, _ = QFileDialog.getSaveFileName(self, '保存网页导出文件', download.downloadFileName())
        if path:
            download.setDownloadDirectory(str(Path(path).parent))
            download.setDownloadFileName(Path(path).name)
            download.accept()
        else:
            download.cancel()

    def closeEvent(self, event):
        if self.worker:
            response = QMessageBox.question(self, '正在下载',
                '等待本次请求结束并保存后自动退出？', QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
            if response == QMessageBox.Yes:
                self.closing_after_download = True
                self.show_status('正在等待本次请求结束，随后自动退出…')
            event.ignore()
            return
        if self.update_worker and self.update_worker.isRunning():
            # urllib cannot be safely interrupted mid-request. Hide immediately,
            # then close after the bounded update request has returned.
            self.update_worker.finished.connect(self.close)
            self.hide()
            event.ignore()
            return
        self.view.stop()
        self.site.close()
        # Release the page before its profile so Chromium can cleanly shut down.
        self.view.setPage(QWebEnginePage(self.view))
        self.page.deleteLater()
        event.accept()


def main():
    app = QApplication(sys.argv)
    app.setApplicationName('iosGuanxing')
    app.setOrganizationName('iosGuanxing')
    app.setApplicationVersion(VERSION)
    app.setWindowIcon(app_icon())
    app.setFont(QFont('Segoe UI', 10))
    root = (Path(os.environ['LOCALAPPDATA']) / 'iosGuanxing' if os.name == 'nt'
            else Path(QStandardPaths.writableLocation(QStandardPaths.AppLocalDataLocation)))
    if getattr(sys, 'frozen', False):
        web = Path(sys._MEIPASS) / 'web'
    else:
        web = Path(__file__).resolve().parents[1] / 'web'
    if os.environ.get('IOSGUANXING_SMOKE_REPORT'):
        from .smoke import run_smoke
        return run_smoke(app, web, Path(os.environ['IOSGUANXING_SMOKE_REPORT']))
    try:
        window = MainWindow(Store(root), web)
    except OSError:
        QMessageBox.critical(None, 'iosGuanxing', '无法创建本地数据目录或启动内置页面，请检查系统权限。')
        return 1
    window.show()
    return app.exec()
