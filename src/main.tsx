import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TitleBar } from "./components/TitleBar";
import { QuickAccess } from "./screens/QuickAccess";
import { QuickWindow } from "./screens/QuickWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QUICK_WINDOW_LABEL } from "./lib/quickBridge";
import { quickMode } from "./lib/tauriApi";

/*
 * Две точки входа в одном приложении.
 *
 * Обычный запуск - полоса заголовка плюс само приложение. Запуск с `--quick`
 * (ярлык быстрого доступа, на который вешают сочетание клавиш) - маленькое
 * окно поиска вместо всего остального, со своей рамкой и своим жизненным
 * циклом, см. `QuickAccess.tsx`.
 *
 * Режим спрашивается ДО первого рендера: показать сначала обычное окно, а
 * потом подменить его на маленькое значило бы моргнуть на весь экран.
 *
 * Полоса заголовка живёт РЯДОМ с приложением, а не внутри: `App` возвращает
 * четыре разных дерева (ошибка запуска, ожидание пути, экран блокировки, само
 * приложение), и рамка окна нужна во всех четырёх - иначе окно нельзя закрыть,
 * пока база не открыта.
 */
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

/*
 * Три входа, а не два.
 *
 * `QuickWindow` - маленькое окно, созданное уже открытым приложением по
 * глобальному сочетанию: база расшифрована в основном окне, PIN не нужен.
 * `QuickAccess` - то же окно, но поднятое ярлыком с `--quick`, когда
 * приложения нет в памяти: там PIN обязателен. Различаются по метке окна.
 */
const isQuickWindow = getCurrentWindow().label === QUICK_WINDOW_LABEL;

void quickMode().then((quick) => {
  root.render(
    <React.StrictMode>
      {isQuickWindow ? (
        <QuickWindow />
      ) : quick ? (
        <QuickAccess />
      ) : (
        <>
          <TitleBar />
          <App />
        </>
      )}
    </React.StrictMode>,
  );
});
