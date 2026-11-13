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

    def download_from_har(self, har_path, progress=lambda text: None):
        """Try the live cloud save, then accept only a complete offline HAR save."""
        try:
            progress('正在读取 HAR 登录会话…')
            session = retrieve.session_from_har(har_path)
            return self.download(session, progress)
        except (ValueError, OSError, RuntimeError) as online_error:
            progress('主动下载未成功，正在检查 HAR 中是否有完整存档…')
            try:
                from yyjh.capture.decode import decode
                parsed = decode(har_path)
                data = parsed.data
                if (not isinstance(data, dict)
                        or not isinstance(data.get('MainRole'), dict)
                        or data.get('Roles') is None
                        or data.get('Rnds') is None):
                    raise ValueError('incomplete HAR save')
            except Exception:
                raise ValueError(
                    f'{online_error}；HAR 中也没有可离线导入的完整存档') from None

            row = self.store.save_snapshot(
                data, parsed.runtime, parsed.server, parsed.version)
            source = next((step.value for step in parsed.steps
                           if step.label == '数据来源'), 'HAR 离线解码')
            warning = (f'主动下载未成功（{online_error}）；已改为从 HAR 离线导入，'
                       f'存档版本 {parsed.version}。数据来源：{source}。')
            return dict(row=row, session=None, warning=warning)
