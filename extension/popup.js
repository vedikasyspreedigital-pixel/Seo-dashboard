const $ = (id) => document.getElementById(id);

async function render() {
  const { status = {} } = await chrome.storage.local.get("status");
  const label =
    status.state === "needs_human"
      ? ['<span class="warn">Waiting for you: tick "verify you are human" in the job window</span>']
      : status.state === "working"
        ? ['<span class="ok">Working…</span>']
        : status.state === "off"
          ? ['<span class="muted">Off</span>']
          : status.connected === false
            ? [`<span class="bad">Not connected</span>`]
            : ['<span class="ok">Connected · waiting for jobs</span>'];
  $("state").innerHTML = label.join("");
  $("job").textContent = status.job ? `${status.job} — ${status.step ?? ""}` : status.error ? status.error : "";
  $("last").textContent = status.lastResult ? `Last: ${status.lastResult}` : "";
  const { recording = false, recordingSteps = [] } = await chrome.storage.local.get(["recording", "recordingSteps"]);
  $("record").textContent = recording ? "■ Stop recording and save the file" : "● Start recording";
  $("recInfo").textContent = recording
    ? `Recording… ${recordingSteps.filter((s) => s.kind === "click").length} clicks so far. Click through the export normally; typed text and passwords are never recorded.`
    : "";
}

$("record").addEventListener("click", async () => {
  const { recording = false } = await chrome.storage.local.get("recording");
  if (recording) {
    await chrome.runtime.sendMessage({ type: "record-stop" });
    // Saved from here (the background worker can't make a file URL): one JSON file in Downloads.
    const { recordingSteps = [] } = await chrome.storage.local.get("recordingSteps");
    const blob = new Blob([JSON.stringify({ version: chrome.runtime.getManifest().version, savedAt: new Date().toISOString(), steps: recordingSteps })], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    await chrome.downloads.download({ url, filename: `serp-console-recording-${stamp}.json`, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $("recInfo").textContent = `Saved ${recordingSteps.length} steps to your Downloads folder (serp-console-recording-….json).`;
    return;
  } else {
    // Screenshots of the recorded pages need Chrome's "read all sites" permission -- asked only for recording.
    await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
    await chrome.runtime.sendMessage({ type: "record-start" });
  }
  render();
});

$("poll").addEventListener("click", () => chrome.runtime.sendMessage({ type: "poll-now" }).then(render, render));
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(render);
render();
