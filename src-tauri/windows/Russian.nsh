; Русские строки установщика.
;
; Копия того, что генерирует Tauri, с правками формулировок. Подключается через
; bundle.windows.nsis.customLanguageFiles - иначе Tauri каждый раз кладёт рядом
; свою версию и правки теряются.
;
; Что изменено и почему:
;   addOrReinstall - было «Добавить/Переустановить компоненты». Компонентов у
;     приложения нет вовсе, выбирать нечего, а человек читает это как вопрос,
;     на который у него нет ответа. По сути кнопка означает «обновить».
;   uninstallBeforeInstalling - было «Удалить перед установкой». Технически это
;     и есть обновление: старая версия снимается, новая ставится в ту же папку,
;     база и резервные копии не затрагиваются. Слово «удалить» здесь пугает без
;     причины.
;   dontUninstall - было «Не удалять». Само по себе непонятно, что произойдёт.
;   chooseMaintenanceOption - «действие, которое вы хотите выполнить» это калька,
;     из которой неясно, о чём вообще речь.
;
; При обновлении Tauri стоит сверить этот файл с заново сгенерированным: если у
; них появятся новые строки, здесь их не будет, и установщик покажет пустоту.

LangString addOrReinstall ${LANG_RUSSIAN} "Обновить"
LangString alreadyInstalled ${LANG_RUSSIAN} "Уже установлено"
LangString alreadyInstalledLong ${LANG_RUSSIAN} "${PRODUCTNAME} ${VERSION} уже установлен. Обновление ставится в ту же папку, база паролей и резервные копии не затрагиваются."
LangString appRunning ${LANG_RUSSIAN} "{{product_name}} запущен! Пожалуйста, закройте приложение и попробуйте еще раз."
LangString appRunningOkKill ${LANG_RUSSIAN} "{{product_name}} запущен!$\nНажмите OK чтобы закрыть приложение"
LangString chooseMaintenanceOption ${LANG_RUSSIAN} "Выберите, что сделать с установленной версией."
LangString choowHowToInstall ${LANG_RUSSIAN} "Выберите, как вы хотите установить ${PRODUCTNAME}."
LangString createDesktop ${LANG_RUSSIAN} "Добавить ярлык на рабочий стол"
LangString dontUninstall ${LANG_RUSSIAN} "Установить поверх, ничего не удаляя"
LangString dontUninstallDowngrade ${LANG_RUSSIAN} "Не удалять (Установка более ранних версий без удаления невозможна)"
LangString failedToKillApp ${LANG_RUSSIAN} "Не удалось закрыть {{product_name}}. Пожалуйста, закройте приложение и попробуйте еще раз"
LangString installingWebview2 ${LANG_RUSSIAN} "Установка WebView2..."
LangString newerVersionInstalled ${LANG_RUSSIAN} "Более новая версия ${PRODUCTNAME} уже установлена! Не рекомендуется устанавливать более раннюю версию. Если вы действительно хотите установить эту версию, рекомендуется сначала удалить текущую. Выберите действие, которое вы хотите выполнить и нажмите Далее для продолжения."
LangString older ${LANG_RUSSIAN} "Более ранняя"
LangString olderOrUnknownVersionInstalled ${LANG_RUSSIAN} "На компьютере уже стоит $R4 версия ${PRODUCTNAME}. Обновление ставится в ту же папку, база паролей и резервные копии не затрагиваются."
LangString silentDowngrades ${LANG_RUSSIAN} "Установка более ранних версий в фоне невозможна, используйте установщик.$\n"
LangString unableToUninstall ${LANG_RUSSIAN} "Не удалось удалить!"
LangString uninstallApp ${LANG_RUSSIAN} "Удалить ${PRODUCTNAME}"
LangString uninstallBeforeInstalling ${LANG_RUSSIAN} "Обновить"
LangString unknown ${LANG_RUSSIAN} "Неизвестная"
LangString webview2AbortError ${LANG_RUSSIAN} "Не удалось установить WebView2! Приложение не может работать без него. Попробуйте перезапустить установщик."
LangString webview2DownloadError ${LANG_RUSSIAN} "Ошибка: Не удалось загрузить WebView2 - $0"
LangString webview2DownloadSuccess ${LANG_RUSSIAN} "WebView2 успешно загружен"
LangString webview2Downloading ${LANG_RUSSIAN} "Загрузка WebView2..."
LangString webview2InstallError ${LANG_RUSSIAN} "Ошибка: Не удалось установить WebView2, код выхода: $1"
LangString webview2InstallSuccess ${LANG_RUSSIAN} "WebView2 успешно установлен"
LangString deleteAppData ${LANG_RUSSIAN} "Удалить данные приложения"
