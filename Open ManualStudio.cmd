@echo off
setlocal EnableExtensions
pushd "%~dp0" || exit /b 1

call :check_runtime
if not errorlevel 1 goto launch
echo ManualStudio requires Node.js 22.18 or newer and npm on PATH.
where.exe node.exe >nul 2>&1 && node.exe --version
where.exe winget.exe >nul 2>&1
if errorlevel 1 goto missing_runtime
choice /c YN /n /m "Install Node.js LTS with WinGet? [Y/N] "
if not "%errorlevel%"=="1" goto missing_runtime
winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget
if errorlevel 1 (
    echo Error: WinGet could not install Node.js LTS. See its output above.
    goto missing_runtime
)
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :check_runtime
if errorlevel 1 goto missing_runtime

:launch
node.exe --experimental-strip-types tools/launch.mjs %*
set "launch_exit=%errorlevel%"
goto finish

:missing_runtime
echo Install or update Node.js LTS from https://nodejs.org/en/download and include npm.
echo Open a new terminal after installation and run Open ManualStudio.cmd again.
set "launch_exit=1"

:finish
if not "%launch_exit%"=="0" pause
popd
exit /b %launch_exit%

:check_runtime
node.exe -e "var v=process.versions.node.split('.').map(Number);process.exit((v[0] === 22 ? v[1] >= 18 : v[0] > 22) ? 0 : 1)" >nul 2>&1
if errorlevel 1 exit /b 1
where.exe npm.cmd >nul 2>&1
exit /b %errorlevel%
