const $ = (id) => document.getElementById(id);

chrome.storage.local.get({ serverUrl: "http://localhost:3001", token: "", enabled: true, watch: false }).then((s) => {
  $("serverUrl").value = s.serverUrl;
  $("token").value = s.token;
  $("enabled").checked = s.enabled;
  $("watch").checked = s.watch;
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim(),
    token: $("token").value.trim(),
    enabled: $("enabled").checked,
    watch: $("watch").checked,
  });
  $("saved").textContent = "Saved";
  chrome.runtime.sendMessage({ type: "poll-now" }).catch(() => {});
  setTimeout(() => ($("saved").textContent = ""), 2000);
});
