const buttons = document.querySelectorAll("[data-tab]");
const workspace = document.querySelector("#workspace");
const connectwifi = document.querySelector("#connectwifi");
const modeTitle = document.querySelector("#mode-title");
const calibration = document.querySelector("#calibration");

// 細かい結果(かかった時間、線の本数、紙の上の大きさなど)は、一般の人にはわかりにくいので隠す。
// URL に ?debug を付けたときだけ出す(例: https://plotsender.otterstb.com/?debug)
const SHOW_DETAILS = new URLSearchParams(location.search).has("debug");

// QR から来たときは ?mode=b(パンタグラフ)で開く
const startTab = new URLSearchParams(location.search).get("mode");
let currentTab = [...buttons].some((b) => b.dataset.tab === startTab) ? startTab : "a";

function switchTab(tab) {
  currentTab = tab;

  for (const button of buttons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.tab === currentTab)
    );
  }

  const isWifi = currentTab === "connectwifi";

  workspace.hidden = isWifi;
  connectwifi.hidden = !isWifi;
  calibration.hidden = currentTab !== "b";   // 補正の欄はパンタグラフだけ

  if (!isWifi) {
    // 見出しはタブのボタンの名前にする
    modeTitle.textContent = [...buttons].find((b) => b.dataset.tab === currentTab).textContent;
    workspace.dataset.mode = currentTab;
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    switchTab(button.dataset.tab);
  });
}

switchTab(currentTab);