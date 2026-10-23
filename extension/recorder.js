// Record mode (content script on the SEO tool sites). Only active while
// "Record" is on in the extension popup. Notes WHICH page you're on and WHAT
// you click so the export flows can be built from it -- never what you type,
// and nothing at all from password fields. The background worker adds a
// screenshot after each click.

(() => {
  if (window.__serpConsoleRecorder) return;
  window.__serpConsoleRecorder = true;

  const safeUrl = (raw) => {
    try {
      const u = new URL(raw, location.href);
      const q = [...u.searchParams.keys()].map((k) => `${k}=…`).join("&");
      return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`;
    } catch {
      return String(raw).split(/[?#]/)[0];
    }
  };

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const isSecret = el.tagName === "INPUT" && el.type === "password";
    const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    const data = {};
    for (const a of el.attributes) if (a.name.startsWith("data-") && a.value.length < 60) data[a.name] = a.value;
    const path = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 6; i++, n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id) {
        path.unshift(`${p}#${n.id}`);
        break;
      }
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`;
      path.unshift(p);
    }
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      id: el.id || undefined,
      name: el.getAttribute("name") || undefined,
      role: el.getAttribute("role") || undefined,
      aria: el.getAttribute("aria-label") || undefined,
      placeholder: isSecret ? undefined : el.getAttribute("placeholder") || undefined,
      href: el.tagName === "A" ? safeUrl(el.getAttribute("href") || "") : undefined,
      text: isSecret || isInput ? undefined : (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined,
      cls: (typeof el.className === "string" ? el.className : "").slice(0, 100) || undefined,
      data: Object.keys(data).length ? data : undefined,
      path: path.join(" > "),
    };
  };

  const send = (entry) => {
    try {
      chrome.runtime.sendMessage({ type: "record", entry: { ...entry, url: safeUrl(location.href), title: document.title.slice(0, 80) } }).catch(() => {});
    } catch {
      // extension reloaded -- this tab's old copy has no connection any more
    }
  };

  // After the extension is reloaded, a tab that was already open keeps this old script with no
  // connection to the extension (chrome.storage is gone) -- stay silent instead of throwing errors.
  const isRecording = async () => {
    try {
      if (!chrome?.storage?.local) return false;
      return (await chrome.storage.local.get({ recording: false })).recording;
    } catch {
      return false;
    }
  };

  isRecording().then((recording) => recording && send({ kind: "page" }));

  document.addEventListener(
    "click",
    async (e) => {
      if (!(await isRecording())) return;
      const target = e.target.closest("button, a, input, select, textarea, label, [role], li, span, div") || e.target;
      send({ kind: "click", el: describe(target) });
    },
    true,
  );

  document.addEventListener(
    "change",
    async (e) => {
      const el = e.target;
      if (!el || !["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || !(await isRecording())) return;
      // Which field changed -- never its value (a dropdown's chosen option text is kept: it's a menu choice like a country).
      const choice = el.tagName === "SELECT" ? el.options[el.selectedIndex]?.text : undefined;
      send({ kind: el.type === "password" ? "password-field" : "field", el: describe(el), choice });
    },
    true,
  );
})();
