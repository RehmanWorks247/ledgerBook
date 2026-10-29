@echo off
cd /d "%~dp0"
call npm.cmd run local:stop
if errorlevel 1 pause
