# iosGuanxing

烟雨观星 Windows 桌面预览版。基于 gx2.8 的存档解析与网页功能，使用 PySide6 / Qt WebEngine 内置显示网页，不再打开 CMD 或外部浏览器。

## 使用

Windows 10/11 x64 下载 Release 中的 `iosGuanxing.exe`，直接运行。

1. 选择或拖入 ProxyPin 导出的 HAR，自动向游戏服务器下载当前云存档。
2. 下载成功后自动进入内置观星主页。
3. 后续点击“下载最新云存档”；登录会话失效后重新导入 HAR。有效期以服务器响应为准，与游戏版本号无直接对应关系。

启动只恢复上次选中的本地存档，不自动联网。历史存档可离线查看。下载只读取服务器已保存的进度，不会上传或覆盖游戏存档。

## 本地数据

数据位于 `%LOCALAPPDATA%\iosGuanxing`。每次成功下载建立独立快照，失败保留原有记录。HAR 原文件不复制；复用所需的登录会话使用 Windows DPAPI 加密，仅当前 Windows 用户可解密。快照是本地明文游戏数据，请自行保管。

内置网页仅访问程序自己的本机随机端口。关闭程序时停止服务。网页运行状态保存在内存中，退出后清除；存档快照单独保留。界面设置、模拟器临时操作在首版中不会跨重启保存。

## 开发与构建

Python 3.11，安装 `requirements-desktop.txt` 后执行 `python desktop_main.py`。正式目标为 Windows，其他平台开发预览不持久化登录会话。

离线测试：`python -m unittest discover -s tests -v`；内置网页验证：`python dev/smoke_desktop.py`。

Windows 打包：安装 PyInstaller 6.x，运行 `python -m PyInstaller --noconfirm iosGuanxing.spec`。推送 `v*` 标签自动构建预览 Release，发布 EXE 与 SHA256 校验文件。

首版使用临时图标，EXE 未签名。自动测试使用合成存档和模拟下载，不连接游戏服务器；实际账号下载需要使用者在 Windows 上验收。
