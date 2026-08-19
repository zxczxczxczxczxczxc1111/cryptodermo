import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TitleBar } from "./components/TitleBar";
import { QuickWindow } from "./screens/QuickWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QUICK_WINDOW_LABEL } from "./lib/quickBridge";

/*
 * Две точки входа в одном приложении, различаются по метке окна.
 *
 * Обычный запуск - полоса заголовка плюс само приложение. `QuickWindow` -
 * маленькое окно, созданное уже открытым приложением по глобальному
 * сочетанию клавиш.
 *
 * До 19.08.2026 входов было три: существовал ещё режим `--quick`, отдельный
 * процесс по ярлыку из меню «Пуск» для случая, когда приложение не запущено.
 * Он удалён по решению пользователя: значок в трее и глобальное сочетание
 * закрывают ту же задачу, а ярлык только плодил лишнюю сущность в меню.
 *
 * Полоса заголовка живёт РЯДОМ с приложением, а не внутри: `App` возвращает
 * четыре разных дерева (ошибка запуска, ожидание пути, экран блокировки, само
 * приложение), и рамка окна нужна во всех четырёх - иначе окно нельзя закрыть,
 * пока база не открыта.
 */
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

const isQuickWindow = getCurrentWindow().label === QUICK_WINDOW_LABEL;

root.render(
  <React.StrictMode>
    {isQuickWindow ? (
      <QuickWindow />
    ) : (
      <>
        <TitleBar />
        <App />
      </>
    )}
  </React.StrictMode>,
);
