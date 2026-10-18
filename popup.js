(() => {
  "use strict";

  const defaults = { enabled: true, showNotice: true, noticeDuration: 1500 };
  const enabled = document.getElementById("enabled");
  const showNotice = document.getElementById("showNotice");
  const noticeDuration = document.getElementById("noticeDuration");
  const saveStatus = document.getElementById("saveStatus");

  function status(message, error = false) {
    saveStatus.textContent = message;
    saveStatus.classList.toggle("error", error);
  }

  function updateAvailability() {
    showNotice.disabled = !enabled.checked;
    noticeDuration.disabled = !enabled.checked || !showNotice.checked;
  }

  function persist(changes) {
    status("저장 중…");
    chrome.storage.local.set(changes, () => {
      if (chrome.runtime.lastError) {
        status("설정을 저장하지 못했습니다.", true);
      } else {
        status("저장됨");
      }
    });
  }

  chrome.storage.local.get(defaults, (saved) => {
    if (chrome.runtime.lastError) {
      status("설정을 불러오지 못했습니다.", true);
      saved = defaults;
    }
    enabled.checked = saved.enabled !== false;
    showNotice.checked = saved.showNotice !== false;
    const duration = Number(saved.noticeDuration);
    noticeDuration.value = Number.isFinite(duration)
      ? Math.min(5000, Math.max(300, Math.round(duration)))
      : defaults.noticeDuration;
    updateAvailability();
  });

  enabled.addEventListener("change", () => {
    updateAvailability();
    persist({ enabled: enabled.checked });
  });
  showNotice.addEventListener("change", () => {
    updateAvailability();
    persist({ showNotice: showNotice.checked });
  });
  noticeDuration.addEventListener("change", () => {
    const value = Number(noticeDuration.value);
    if (!Number.isFinite(value) || value < 300 || value > 5000) {
      status("알림 시간은 300~5000ms로 입력하세요.", true);
      return;
    }
    const rounded = Math.round(value);
    noticeDuration.value = rounded;
    persist({ noticeDuration: rounded });
  });
})();
