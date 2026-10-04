@echo off
rem Запуск мессенджера из исходников (нужен установленный Node.js 18+)
cd /d "%~dp0"
if not exist "server\node_modules" (
  echo Первый запуск: ставлю зависимости...
  cd server
  call npm install --no-audit --no-fund
  cd ..
)
node server\server.js --open %*
pause
