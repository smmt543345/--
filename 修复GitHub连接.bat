@echo off
chcp 65001 >nul
echo ============================================
echo  修复 GitHub 连接 v2（自动探测可用 IP）
echo ============================================
echo.
echo 正在测试 GitHub 官方 IP（约 20 秒）...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ips = '20.27.177.113','20.205.243.166','140.82.116.4','140.82.112.3','140.82.112.4','140.82.113.4','140.82.114.4','140.82.121.3','140.82.121.4','20.200.245.247';" ^
  "$pick = $null; foreach ($ip in $ips) { $c = New-Object System.Net.Sockets.TcpClient; $t = $c.BeginConnect($ip, 443, $null, $null); if ($t.AsyncWaitHandle.WaitOne(1500) -and $c.Connected) { $pick = $ip; $c.Close(); break }; $c.Close() };" ^
  "if (-not $pick) { Write-Host '没有一个 IP 可达，稍后再试'; exit 1 };" ^
  "$line = \"$pick github.com\";" ^
  "$hosts = \"$env:SystemRoot\System32\drivers\etc\hosts\";" ^
  "$content = if (Test-Path $hosts) { Get-Content $hosts } else { @() };" ^
  "$content = $content | Where-Object { $_ -notmatch 'github\.com' };" ^
  "$content = $content + $line;" ^
  "Set-Content -Path $hosts -Value $content -Encoding ASCII;" ^
  "ipconfig /flushdns | Out-Null;" ^
  "Write-Host \"已写入 hosts: $line\""

if %errorlevel%==0 (
  echo.
  echo 修复完成。现在浏览器和 GitHub Desktop 都能连了。
) else (
  echo.
  echo 探测失败，可能网络整体受限。稍后重试，或改用代理。
)
pause
