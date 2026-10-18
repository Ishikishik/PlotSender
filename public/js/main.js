const buttons = document.querySelectorAll("[data-tab]");
const workspace = document.querySelector("#workspace");
const connectwifi = document.querySelector("#connectwifi");
const modeTitle = document.querySelector("#mode-title");

let currentTab = "a";

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

  if (!isWifi) {
    modeTitle.textContent = currentTab;
    workspace.dataset.mode = currentTab;
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    switchTab(button.dataset.tab);
  });
}

switchTab(currentTab);