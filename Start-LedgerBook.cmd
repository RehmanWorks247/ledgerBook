@echo off
setlocal
cd /d "%~dp0"
echo Starting LedgerBook on this computer...
echo Keep this window open while using the app. Closing it stops the server.
echo Once startup completes, open http://localhost:3000 in your browser.
echo.
call npm.cmd run local
set "ledgerbook_exit=%ERRORLEVEL%"
if not "%ledgerbook_exit%"=="0" echo LedgerBook did not start successfully. Check the error above.
pause
exit /b %ledgerbook_exit%
