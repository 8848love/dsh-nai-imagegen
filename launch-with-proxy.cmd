@echo off
rem ===========================================================================
rem  Launch DeepSeek Harness inside a proxy environment.
rem
rem  Why this exists: Node's fetch ignores the Windows system proxy, and the
rem  NODE_USE_ENV_PROXY / HTTPS_PROXY pair is only read when Node starts, so a
rem  process that needs a proxy must be launched with those variables already
rem  set. (The nai-imagegen plugin now tunnels by itself and no longer needs
rem  this, but other Node-based tooling inside DSH still does.)
rem
rem  The proxy is read from the registry instead of being hardcoded, so changing
rem  the port or turning the proxy off is picked up automatically.
rem
rem  Keep this file pure ASCII: cmd.exe reads it in the OEM code page, and
rem  non-ASCII bytes in a .cmd file can garble output or break parsing.
rem
rem  Double-click this file, or run it from a terminal.
rem ===========================================================================
setlocal EnableExtensions

set "KEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
set "EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"

for /f "tokens=3" %%A in ('reg query "%KEY%" /v ProxyEnable 2^>nul ^| findstr /i "ProxyEnable"') do set "PROXYENABLE=%%A"
for /f "tokens=2*" %%A in ('reg query "%KEY%" /v ProxyServer 2^>nul ^| findstr /i "ProxyServer"') do set "PROXYSERVER=%%B"

if not defined PROXYSERVER goto :noproxy
if /i not "%PROXYENABLE%"=="0x1" goto :disabled

rem A per-protocol value looks like "http=host:port;https=host:port" - keep https.
echo %PROXYSERVER% | findstr /i "=" >nul
if not errorlevel 1 (
  for /f "tokens=2 delims==" %%A in ('echo %PROXYSERVER% ^| findstr /i "https"') do set "PROXYSERVER=%%A"
  set "PROXYSERVER=%PROXYSERVER:;=%"
)

echo %PROXYSERVER% | findstr /i /r "^http:// ^https://" >nul
if errorlevel 1 (set "PROXYURL=http://%PROXYSERVER%") else (set "PROXYURL=%PROXYSERVER%")

set "HTTPS_PROXY=%PROXYURL%"
set "HTTP_PROXY=%PROXYURL%"
set "NODE_USE_ENV_PROXY=1"
echo [proxy] %PROXYURL%
echo [env]   NODE_USE_ENV_PROXY=1  HTTPS_PROXY=%PROXYURL%
goto :launch

:noproxy
echo [proxy] none configured - launching without one
goto :launch

:disabled
echo [proxy] configured but disabled - launching without one
goto :launch

:launch
if not exist "%EXE%" (
  echo.
  echo Cannot find: "%EXE%"
  echo Edit EXE in this script to point at your DeepSeek Harness executable.
  pause
  exit /b 1
)
start "" "%EXE%"
exit /b 0
