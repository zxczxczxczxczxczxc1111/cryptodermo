import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TitleBar } from "./components/TitleBar";

/*
 * Полоса заголовка живёт РЯДОМ с приложением, а не внутри него.
 *
 * `App` возвращает четыре разных дерева (ошибка запуска, ожидание пути, экран
 * блокировки, само приложение), и рамка окна нужна во всех четырёх - иначе
 * окно нельзя закрыть, пока база не открыта. Это не состояние приложения, а
 * элемент окна, поэтому и монтируется отдельно.
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TitleBar />
    <App />
  </React.StrictMode>,
);
