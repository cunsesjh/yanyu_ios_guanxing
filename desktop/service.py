"""One user-initiated download; failed refreshes leave history and session intact."""
from yyjh.capture import retrieve


class DownloadService:
    def __init__(self, store):
        self.store = store

    def download(self, session, progress=lambda text: None):
        progress('正在向游戏服务器请求当前云存档…')
        data, version, _ = retrieve.fetch(session)
        progress('解码校验成功，正在保存完整存档…')
        row = self.store.save_snapshot(data, session['platform'], session['area'], version)
        warning = ''
        try:
            self.store.save_session(session)
        except (OSError, RuntimeError, ValueError):
            warning = '存档已保存；会话未能加密保存，重新启动后需要再次导入 HAR。'
        return dict(row=row, session=session, warning=warning)
