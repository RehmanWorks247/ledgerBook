@echo off
cd /d "%~dp0"
call pnpm.cmd stop
if errorlevel 1 pause
