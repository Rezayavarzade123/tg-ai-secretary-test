@echo off
rem tg-secretary on Windows: this wrapper exists so the command works from cmd.exe
rem and PowerShell alike. It hands everything to tg-secretary.ps1 next to it.
rem Written by hand, not generated.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tg-secretary.ps1" %*
exit /b %errorlevel%
