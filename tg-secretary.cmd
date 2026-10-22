@echo off
rem tg-secretary, from this checkout, without installing first.
rem cmd.exe only searches the current directory and PATH, so a command in bin\ is
rem invisible from the repository root. After install.ps1 the installed bin directory
rem is on your PATH and this file is not needed; it keeps working either way, and it
rem always controls the checkout it sits in.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\tg-secretary.ps1" %*
exit /b %errorlevel%
