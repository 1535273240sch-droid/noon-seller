import "./style.css";
document.querySelector("#open")!.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("desk.html") });
  window.close();
});
