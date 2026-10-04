@echo off
chcp 65001 >nul
title Контур - полная очистка сервера
echo.
echo   МЕССЕНДЖЕР "КОНТУР" - ПОЛНАЯ ОЧИСТКА СЕРВЕРА (СТЕРЕТЬ ВСЁ ПОД НОЛЬ)
echo   ==================================================================
echo.
echo   Будут удалены: аккаунты, чаты, вся переписка, загруженные файлы,
echo   демо-боты и группы, сертификаты и ключи сессий (все будут разлогинены).
echo.
echo   Папки, которые чистятся:
echo     %LOCALAPPDATA%\Kontur
if defined KONTUR_DATA echo     %KONTUR_DATA%
if exist "%~dp0data" echo     %~dp0data
echo.
echo   ВАЖНО: перед очисткой закройте KonturServer.exe (окно сервера).
echo.
set /p yes="  Продолжить? Напишите y и нажмите Enter: "
if /i not "%yes%"=="y" (
  echo.
  echo   Отменено - ничего не тронуто.
  pause
  exit /b 0
)

taskkill /IM KonturServer.exe /F >nul 2>&1
taskkill /IM Kontur.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul

if exist "%LOCALAPPDATA%\Kontur" (
  rmdir /s /q "%LOCALAPPDATA%\Kontur"
  echo   [ок] Удалено: %LOCALAPPDATA%\Kontur
) else (
  echo   [--] Папка %LOCALAPPDATA%\Kontur уже пуста
)

if defined KONTUR_DATA if exist "%KONTUR_DATA%" (
  rmdir /s /q "%KONTUR_DATA%"
  echo   [ок] Удалено: %KONTUR_DATA%
)

if exist "%~dp0data" (
  rmdir /s /q "%~dp0data"
  echo   [ок] Удалено: %~dp0data
)

if exist "%~dp0server\data" (
  rmdir /s /q "%~dp0server\data"
  echo   [ок] Удалено: %~dp0server\data
)

echo.
echo   Готово: база пустая. Ни пользователей, ни чатов, ни сообщений,
echo   ни демо-ботов - регистрируйтесь заново на странице входа.
echo.
echo   Подсказка: то же самое делает флаг KonturServer.exe --fresh
echo   (но его нельзя оставлять на каждый запуск - база будет стираться всегда).
echo.
set /p run="  Запустить чистый сервер прямо сейчас? Напишите y и нажмите Enter: "
if /i "%run%"=="y" (
  if exist "%~dp0KonturServer.exe" (
    echo   Запускаю KonturServer.exe...
    start "" "%~dp0KonturServer.exe"
  ) else (
    echo   [--] KonturServer.exe рядом не найден - запустите его вручную.
  )
)
echo.
pause
