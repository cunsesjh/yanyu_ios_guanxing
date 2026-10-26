@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 烟雨观星 · Windows exe 构建

echo [1/3] 安装构建依赖 ...
py -3 -m pip install --upgrade pip >nul 2>&1
py -3 -m pip install pyinstaller -r requirements.txt
if errorlevel 1 (
    echo 依赖安装失败。也可以用 python 代替 py -3 再跑一次。
    pause & exit /b 1
)

if not exist adb\adb.exe (
    echo [2/3] 下载 adb（platform-tools）...
    powershell -NoProfile -Command "Invoke-WebRequest https://dl.google.com/android/repository/platform-tools-latest-windows.zip -OutFile %TEMP%\yyjh_pt.zip"
    powershell -NoProfile -Command "Expand-Archive %TEMP%\yyjh_pt.zip -DestinationPath %TEMP%\yyjh_pt -Force"
    mkdir adb 2>nul
    copy /y %TEMP%\yyjh_pt\platform-tools\adb.exe adb\ >nul
    copy /y %TEMP%\yyjh_pt\platform-tools\AdbWinApi.dll adb\ >nul
    copy /y %TEMP%\yyjh_pt\platform-tools\AdbWinUsbApi.dll adb\ >nul
) else (
    echo [2/3] adb 已就绪，跳过下载。
)

echo [3/3] 打包 exe ...
py -3 -m PyInstaller yyjh-guanxing.spec --noconfirm
if errorlevel 1 (
    echo 构建失败。
    pause & exit /b 1
)

echo.
echo 构建完成：dist\ios观星.exe
pause
::v2.6-版本号对齐
