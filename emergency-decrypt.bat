@echo off
chcp 65001 >nul
setlocal
title Аварийная расшифровка базы cryptodermo

rem  emergency-decrypt.bat - обёртка над emergency-decrypt.py для тех, кто не
rem  хочет открывать командную строку. Перетащите vault.dat на этот файл (или
rem  просто запустите его двойным щелчком и укажите путь), введите мастер-пароль
rem  и получите рядом с базой файл vault-decrypted.json с содержимым.
rem
rem  Сам батник ничего не расшифровывает: вся работа в emergency-decrypt.py и
rem  aes_gcm.py, которые лежат рядом. Он только находит Python, проверяет, что
rem  все три файла на месте, и складывает результат в файл вместо экрана -
rem  чтобы расшифрованные пароли не остались в истории окна консоли.

echo.
echo   Аварийная расшифровка базы cryptodermo
echo   ---------------------------------------
echo.

set "HERE=%~dp0"
set "VAULT=%~1"

if "%VAULT%"=="" (
    echo   Перетащите vault.dat на этот файл, либо укажите путь к нему сейчас.
    echo.
    set /p "VAULT=  Путь к vault.dat: "
)
if "%VAULT%"=="" goto :no_vault

rem  Путь мог приехать в кавычках (перетаскивание или ручной ввод) - снимаем их.
set "VAULT=%VAULT:"=%"

if not exist "%VAULT%" goto :no_such_file
if not exist "%HERE%emergency-decrypt.py" goto :no_script
if not exist "%HERE%aes_gcm.py" goto :no_script

rem  Сначала py.exe (штатный лаунчер Python под Windows), потом python.exe -
rem  в разных установках есть то одно, то другое.
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY goto :no_python

rem  Результат кладём рядом с самой базой, а не рядом с батником: базу могли
rem  принести из бэкапа или с флешки, и складывать расшифрованное в чужой
rem  каталог - неожиданное поведение.
for %%F in ("%VAULT%") do set "OUT=%%~dpFvault-decrypted.json"

if exist "%OUT%" (
    echo   Файл уже существует:
    echo     %OUT%
    echo.
    set /p "OVERWRITE=  Перезаписать? [y/N]: "
    if /i not "%OVERWRITE%"=="y" goto :cancelled
    echo.
)

echo   База:      %VAULT%
echo   Результат: %OUT%
echo.
echo   Введите мастер-пароль (символы не отображаются):

%PY% "%HERE%emergency-decrypt.py" "%VAULT%" > "%OUT%"
if errorlevel 1 goto :failed

echo.
echo   Готово. Данные лежат здесь:
echo     %OUT%
echo.
echo   ВНИМАНИЕ: этот файл НЕ зашифрован. В нём все пароли открытым текстом.
echo   Удалите его, как только перенесёте данные куда нужно.
echo.

set /p "UNPACK=  Распаковать ещё и вложения? [y/N]: "
if /i not "%UNPACK%"=="y" goto :done

for %%F in ("%VAULT%") do set "ATT=%%~dpFattachments"
echo.
echo   Введите мастер-пароль ещё раз:
%PY% "%HERE%emergency-decrypt.py" "%VAULT%" --unpack-attachments "%ATT%" >nul
if errorlevel 1 goto :failed
echo.
echo   Вложения распакованы в: %ATT%
goto :done

:no_vault
echo   Путь не указан, делать нечего.
goto :end

:no_such_file
echo   Файл не найден:
echo     %VAULT%
goto :end

:no_script
echo   Рядом с этим батником должны лежать emergency-decrypt.py и aes_gcm.py.
echo   Сейчас их там нет:
echo     %HERE%
echo.
echo   Возьмите оба файла из каталога с базой или из любого бэкапа - они
echo   копируются туда при каждом сохранении.
goto :end

:no_python
echo   Python не найден. Установите его с python.org (подойдёт любая версия 3.x)
echo   и при установке отметьте галочку "Add Python to PATH", затем запустите
echo   этот файл снова.
echo.
echo   Если Python установлен, но не находится - откройте командную строку в
echo   каталоге с базой и выполните вручную:
echo     python emergency-decrypt.py vault.dat
goto :end

:failed
echo.
echo   Не получилось. Обычно это неверный мастер-пароль; текст ошибки выше.
if exist "%OUT%" del "%OUT%"
goto :end

:cancelled
echo.
echo   Отменено, ничего не тронуто.
goto :end

:done
echo.

:end
echo.
pause
endlocal
