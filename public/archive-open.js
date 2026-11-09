"use strict";
const heading = document.getElementById("heading");
const status = document.getElementById("status");
const retry = document.getElementById("retry");
const ready = document.getElementById("ready");
const id = new URLSearchParams(location.search).get("id");
let running = false;
async function openArchive() {
  if (running) return;
  running = true;
  retry.hidden = true;
  ready.hidden = true;
  heading.textContent = "Открываем папку…";
  status.textContent =
    "Создаём защищённую ссылку. Первое открытие может занять около минуты.";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  async function request(path, body) {
    const response = await fetch("/api/archive" + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.status === 401)
      throw Error("Войдите в Jorik и повторите открытие папки.");
    if (
      !(response.headers.get("content-type") || "").includes("application/json")
    )
      throw Error("Сервер сейчас не отвечает. Попробуйте ещё раз позже.");
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Не удалось открыть папку.");
    return data;
  }
  try {
    if (!/^[a-f0-9]{24}$/.test(id || ""))
      throw Error("Неверная ссылка на архив. Откройте папку из поиска Jorik.");
    let result = await request("/link", { id });
    const taskId = result.taskId;
    const deadline = Date.now() + 115000;
    while (!result.url && taskId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      result = await request("/links/" + encodeURIComponent(taskId));
      if (result.state === "error")
        throw Error(result.error || "Не удалось создать ссылку.");
    }
    if (!result.url)
      throw Error(
        "Сервер долго готовит ссылку. Нажмите «Повторить» чуть позже.",
      );
    const url = new URL(result.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("Некорректная ссылка на архив.");
    ready.href = url.href;
    ready.hidden = false;
    heading.textContent = "Ссылка готова";
    status.textContent =
      "Переходим в архив. Если переход не произошёл, нажмите «Открыть папку».";
    location.replace(url.href);
  } catch (error) {
    heading.textContent = "Не удалось открыть папку";
    status.textContent = controller.signal.aborted
      ? "Сервер не ответил за две минуты. Попробуйте ещё раз позже."
      : error instanceof Error
        ? error.message
        : "Ошибка соединения с сервером.";
    retry.hidden = false;
  } finally {
    clearTimeout(timer);
    running = false;
  }
}
retry.addEventListener("click", openArchive);
void openArchive();
