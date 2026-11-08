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

    def import_passive(self, har, session=None, progress=lambda text: None):
        """主动下载失败后的兜底：离线导入 HAR 里已下载的存档。

        旧式明文 download 响应（国际服等）本身就带完整存档
        （data = 初版 content + extra 下发 psw）；会话过期/断网时
        不必让用户白抓一次。只接受含 Rnds 世界种子的完整存档。
        """
        from yyjh.capture import decode
        progress('正在离线解码抓包里的存档…')
        got = decode.download_body(har)
        data = got['data']
        if not all(field in data for field in ('MainRole', 'Roles', 'Rnds')):
            raise ValueError('抓包里的存档不完整（缺 Rnds 世界种子），无法离线导入')
        row = self.store.save_snapshot(data, got['runtime'], got['server'],
                                      str(int(got['version'])))
        if session:
            try:
                self.store.save_session(session)
            except (OSError, RuntimeError, ValueError):
                session = None
        return dict(row=row, session=session, warning='')
