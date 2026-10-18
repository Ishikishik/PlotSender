const checkServerButton = document.querySelector("#check-server");
const serverStatus = document.querySelector("#server-status");

checkServerButton.addEventListener("click", async () => {
  checkServerButton.disabled = true;
  serverStatus.textContent = "接続を確認しています…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    // 同じサイトのPython APIにGETリクエストを送る。
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const time = new Date(data.server_time);
    if (data.ok !== true || Number.isNaN(time.getTime())) {
      throw new Error("サーバーの応答形式が正しくありません");
    }

    serverStatus.textContent = `接続成功 — サーバー時刻：${time.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
    })}（日本時間）`;
  } catch (error) {
    serverStatus.textContent = error.name === "AbortError"
      ? "接続がタイムアウトしました。もう一度お試しください。"
      : `接続できませんでした。開発サーバーが起動しているか確認してください。（${error.message}）`;
  } finally {
    clearTimeout(timeout);
    checkServerButton.disabled = false;
  }
});
