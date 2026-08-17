; Хуки установщика NSIS - подключаются через bundle.windows.nsis.installerHooks
; в tauri.conf.json.
;
; Зачем: приложение портативное, база лежит рядом с .exe. Деинсталлятор Tauri
; удаляет только то, что сам туда положил, поэтому после удаления в папке
; оставались vault.dat, vault.settings.json, backups/ и два скрипта аварийной
; расшифровки. Галочка «удалить данные приложения» на них не влияет: она
; относится к %APPDATA%\<идентификатор> и ключам реестра, то есть к данным
; WebView2, а не к файлам, которые приложение создало само.
;
; Почему отдельный вопрос, а не тихое удаление по той галочке: vault.dat - это
; единственная копия всех паролей пользователя. Человек, сносящий версию ради
; установки следующей, вполне может поставить галочку с надписью «удалить
; данные приложения», не подумав про базу. Цена ошибки несоразмерна экономии
; одного клика, поэтому вопрос задаётся прямым текстом и по умолчанию выбран
; ответ «Нет».
;
; Вопрос задаётся только если удалять действительно есть что: на чистой папке
; (базу перенесли в другое место через настройки) деинсталлятор молчит.

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Второй ярлык - режим быстрого доступа (флаг --quick). Именно на него
  ; человек вешает сочетание клавиш: правой кнопкой по ярлыку, «Свойства»,
  ; поле «Быстрый вызов». Windows умеет это сама, поэтому приложению не нужен
  ; ни плагин глобальных горячих клавиш, ни постоянное присутствие в памяти.
  ;
  ; Ярлык кладётся рядом с основным, тем же способом, что и он сам (см.
  ; CreateStartMenuShortcut в шаблоне Tauri): в подпапку меню «Пуск», если она
  ; используется, иначе прямо в меню.
  !if "${STARTMENUFOLDER}" != ""
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME} (быстрый доступ).lnk"       "$INSTDIR\${MAINBINARYNAME}.exe" "--quick"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME} (быстрый доступ).lnk"       "$INSTDIR\${MAINBINARYNAME}.exe" "--quick"
  !endif
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Ярлык быстрого доступа создан нами, значит и убирать его нам: шаблон о нём
  ; не знает и оставил бы висеть в меню «Пуск» после удаления программы.
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME} (быстрый доступ).lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME} (быстрый доступ).lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Условия, при которых вопрос вообще уместен:
  ;
  ;   $DeleteAppDataCheckboxState - та самая галочка «удалить данные
  ;     приложения» в окне деинсталлятора. Переменная объявлена в шаблоне
  ;     Tauri, куда этот файл включается (см. installer.nsi, блок над вызовом
  ;     хука). Если её однажды переименуют, makensis упадёт на сборке с
  ;     «undefined variable» - молча сломаться эта привязка не может.
  ;
  ;   $UpdateMode - деинсталлятор запущен установщиком новой версии. Удалять
  ;     базу при обновлении нельзя ни при каких галочках.
  ;
  ;   IfSilent - тихое удаление (ключ /S) не должно ни спрашивать, ни решать
  ;     за пользователя: данные остаются на месте.
  ${If} $DeleteAppDataCheckboxState <> 1
  ${OrIf} $UpdateMode = 1
    Goto cryptodermo_keep_data
  ${EndIf}
  IfSilent cryptodermo_keep_data

  IfFileExists "$INSTDIR\vault.dat" cryptodermo_ask_data 0
  IfFileExists "$INSTDIR\backups\*.*" cryptodermo_ask_data 0
  Goto cryptodermo_keep_data

cryptodermo_ask_data:
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "Удалить базу паролей и все резервные копии?$\r$\n$\r$\nБудут безвозвратно удалены vault.dat, папка backups и настройки. Восстановить их без резервной копии в другом месте будет невозможно.$\r$\n$\r$\nНет - файлы останутся в $INSTDIR." \
    IDYES cryptodermo_delete_data
  Goto cryptodermo_keep_data

cryptodermo_delete_data:
  Delete "$INSTDIR\vault.dat"
  Delete "$INSTDIR\vault.settings.json"
  ; Скрипты аварийной расшифровки приложение копирует рядом с базой при каждом
  ; сохранении - без базы они бессмысленны.
  Delete "$INSTDIR\emergency-decrypt.py"
  Delete "$INSTDIR\aes_gcm.py"
  RMDir /r "$INSTDIR\backups"
  ; Только если папка опустела: RMDir без /r не трогает непустой каталог, и
  ; чужие файлы, случайно положенные пользователем рядом, переживут удаление.
  RMDir "$INSTDIR"

cryptodermo_keep_data:
!macroend
