(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled: true,
    showNotice: true,
    noticeDuration: 1500
  });
  const NOTICE_ID = "random-password-backspace-notice";
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

  // Do not act until saved settings have loaded. No password is stored here.
  let settings = { ...DEFAULTS, enabled: false };
  let composing = false;
  let notice = null;
  let noticeInput = null;
  let noticeTimer = null;
  let positionFrame = null;

  function normalizeSettings(values) {
    const duration = Number(values.noticeDuration);
    return {
      enabled: values.enabled !== false,
      showNotice: values.showNotice !== false,
      noticeDuration: Number.isFinite(duration)
        ? Math.min(5000, Math.max(300, Math.round(duration)))
        : DEFAULTS.noticeDuration
    };
  }

  function loadSettings() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      settings = { ...DEFAULTS };
      return;
    }

    chrome.storage.local.get(DEFAULTS, (values) => {
      settings = normalizeSettings(chrome.runtime?.lastError ? DEFAULTS : values);
      if (!settings.enabled || !settings.showNotice) hideNotice();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const next = { ...settings };
      for (const key of Object.keys(DEFAULTS)) {
        if (Object.hasOwn(changes, key)) {
          next[key] = changes[key].newValue ?? DEFAULTS[key];
        }
      }
      settings = normalizeSettings(next);
      if (!settings.enabled || !settings.showNotice) hideNotice();
    });
  }

  function eventPath(event) {
    return typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];
  }

  function passwordInputFor(event) {
    for (const node of eventPath(event)) {
      if (node instanceof HTMLInputElement && node.type === "password") {
        return node;
      }
    }
    return null;
  }

  function isFocused(input) {
    const root = input.getRootNode();
    return root.activeElement === input;
  }

  // One byte has 255 accepted outcomes: exactly 85 for each result.
  function randomCount() {
    const byte = new Uint8Array(1);
    do {
      crypto.getRandomValues(byte);
    } while (byte[0] === 255);
    return (byte[0] % 3) + 1;
  }

  function graphemeEnds(value, caret) {
    const ends = [0];
    if (segmenter) {
      for (const item of segmenter.segment(value)) {
        const end = item.index + item.segment.length;
        if (end > caret) break;
        ends.push(end);
      }
    } else {
      // Modern Chrome has Intl.Segmenter. This fallback at least avoids
      // splitting a UTF-16 surrogate pair in older Chromium builds.
      let end = 0;
      for (const codePoint of value) {
        end += codePoint.length;
        if (end > caret) break;
        ends.push(end);
      }
    }
    return ends;
  }

  function deletionPlan(value, caret, wanted) {
    const ends = graphemeEnds(value, caret);
    const available = ends.length - 1;
    const deleted = Math.min(wanted, available);
    return {
      start: ends[available - deleted],
      end: ends[available],
      deleted
    };
  }

  function hideNotice() {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    if (positionFrame !== null) {
      cancelAnimationFrame(positionFrame);
      positionFrame = null;
    }
    notice?.remove();
    notice = null;
    noticeInput = null;
  }

  function positionNotice() {
    positionFrame = null;
    if (!notice || !noticeInput) return;
    if (!noticeInput.isConnected || !isFocused(noticeInput)) {
      hideNotice();
      return;
    }

    const inputRect = noticeInput.getBoundingClientRect();
    const noticeRect = notice.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth);
    const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight);
    const gap = 6;
    const margin = 8;
    const left = Math.min(
      Math.max(inputRect.right - noticeRect.width, leftEdge + margin),
      Math.max(leftEdge + margin, rightEdge - noticeRect.width - margin)
    );
    const below = inputRect.bottom + gap;
    const above = inputRect.top - gap - noticeRect.height;
    const preferredTop = below + noticeRect.height + margin <= bottomEdge
      ? below
      : above >= topEdge + margin ? above : below;
    const top = Math.min(
      Math.max(preferredTop, topEdge + margin),
      Math.max(topEdge + margin, bottomEdge - noticeRect.height - margin)
    );
    notice.style.left = `${Math.round(left)}px`;
    notice.style.top = `${Math.round(top)}px`;
    notice.style.visibility = "visible";
  }

  function queuePosition() {
    if (notice && positionFrame === null) {
      positionFrame = requestAnimationFrame(positionNotice);
    }
  }

  function showNotice(input, deleted) {
    if (!settings.showNotice || deleted === 0) return;
    if (!notice) {
      notice = document.createElement("div");
      notice.id = NOTICE_ID;
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      notice.setAttribute("aria-atomic", "true");
      document.documentElement.appendChild(notice);
    }
    noticeInput = input;
    notice.textContent = `${deleted}글자 삭제`;
    notice.style.visibility = "hidden";
    positionNotice();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, settings.noticeDuration);
  }

  function onKeyDown(event) {
    if (event.key !== "Backspace") return;
    if (!settings.enabled || event.defaultPrevented ||
        event.isComposing || composing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      hideNotice();
      return;
    }

    const input = passwordInputFor(event);
    if (!input || !input.isConnected || input.matches(":disabled") ||
        input.readOnly || !isFocused(input)) {
      hideNotice();
      return;
    }
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === null || end === null || start !== end || start === 0) {
      // Browser behavior is preserved for an existing selection and at the start.
      hideNotice();
      return;
    }

    const value = input.value;
    const plan = deletionPlan(value, start, randomCount());
    if (plan.deleted === 0) {
      // The caret may have been placed inside the first grapheme. Prevent a
      // native Backspace from tearing the grapheme into invalid fragments.
      hideNotice();
      event.preventDefault();
      return;
    }

    event.preventDefault();

    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "deleteContentBackward"
    });
    if (!input.dispatchEvent(before)) {
      hideNotice();
      return;
    }
    // Some sites mutate or replace the control in beforeinput. Avoid a second
    // edit in that case, and let the site own its change.
    if (!input.isConnected || !isFocused(input) || input.type !== "password" ||
        input.matches(":disabled") || input.readOnly || input.value !== value ||
        input.selectionStart !== start || input.selectionEnd !== end) {
      hideNotice();
      return;
    }

    try {
      HTMLInputElement.prototype.setRangeText.call(input, "", plan.start, plan.end, "start");
    } catch {
      hideNotice();
      return;
    }
    const expected = value.slice(0, plan.start) + value.slice(plan.end);
    if (input.value !== expected) {
      hideNotice();
      return;
    }

    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "deleteContentBackward"
    }));
    if (input.isConnected && isFocused(input) && input.type === "password" &&
        input.value === expected) showNotice(input, plan.deleted);
    else hideNotice();
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("compositionstart", () => { composing = true; }, true);
  document.addEventListener("compositionend", () => { composing = false; }, true);
  document.addEventListener("focusout", (event) => {
    if (noticeInput && eventPath(event).includes(noticeInput)) hideNotice();
  }, true);
  window.addEventListener("scroll", queuePosition, true);
  window.addEventListener("resize", queuePosition);
  window.visualViewport?.addEventListener("scroll", queuePosition);
  window.visualViewport?.addEventListener("resize", queuePosition);

  loadSettings();
})();
