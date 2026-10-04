@echo off
chcp 65001 >nul
title Контур — очистка данных сервера
echo.
echo   МЕССЕНДЖЕР «КОНТУР» — ПОЛНАЯ ОЧИСТКА ДАННЫХ СЕРВЕРА
echo   =====================================================
echo.
echo   Будут удалены: аккаунты, чаты, сообщения, файлы и настройки.
echo   Папки, которые чистятся:
echo     %LOCALAPPDATA%\Kontur\data
if defined KONTUR_DATA echo     %KONTUR_DATA%
echo.
echo   ВАЖНО: перед очисткой закройте KonturServer.exe (окно сервера).
echo.
set /p yes="  Продолжить? Напишите y и нажмите Enter: "
if /i not "%yes%"=="y" (
  echo.
  echo   Отменено — ничего не тронуто.
  pause
  exit /b 0
)

taskkill /IM KonturServer.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul

if exist "%LOCALAPPDATA%\Kontur\data" (
  rmdir /s /q "%LOCALAPPDATA%\Kontur\data"
  echo   [ок] Удалено: %LOCALAPPDATA%\Kontur\data
) else (
  echo   [--] Папка %LOCALAPPDATA%\Kontur\data уже пуста
)

if defined KONTUR_DATA if exist "%KONTUR_DATA%" (
  rmdir /s /q "%KONTUR_DATA%"
  echo   [ок] Удалено: %KONTUR_DATA%
)

echo.
echo   Готово. Запустите KonturServer.exe заново — база будет чистой:
echo   ни пользователей, ни чатов, ни сообщений. Регистрируйтесь заново.
echo.
echo   Подсказка: то же самое можно сделать флагом KonturServer.exe --fresh
echo.
pause
