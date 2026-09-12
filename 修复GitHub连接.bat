@echo off
chcp 65001 >nul
echo ============================================
echo  修复 GitHub 连接（写入 hosts，幂等）
echo ============================================
set HOSTS=%SystemRoot%\System32\drivers\etc\hosts
set LINE=20.200.245.247 github.com

findstr /C:"github.com" "%HOSTS%" >nul 2>&1
if %errorlevel%==0 (
  echo hosts 里已有 github.com 条目，无需重复写入。
) else (
  echo %LINE%>> "%HOSTS%"
  echo 已写入：%LINE%
)
ipconfig /flushdns >nul
echo DNS 缓存已刷新。
echo.
echo 现在可以回到 GitHub Desktop 重新 Publish 了。
pause
