// Promise-based modal dialogs.
//
// Replaces native alert/confirm/prompt: those cannot be styled, look foreign
// inside the app, read badly on a phone, and OK/Cancel cannot express a
// three-way choice such as "Replace / Create new / Cancel".
//
// Every helper resolves to null when the user dismisses the dialog (Escape,
// backdrop, Cancel, or the header close button), which is exactly what the
// existing `if(!value) return;` call sites expect.

const stack = [];

// Capture phase, so this runs before the bubble-phase keydown handler in
// app.js that closes the sidebar and leaves focus mode. While a modal is open
// that handler must not see Escape at all.
document.addEventListener("keydown", (e) => {
  if(!stack.length) return;
  const top = stack[stack.length - 1];

  if(e.key === "Escape"){
    e.preventDefault();
    e.stopPropagation();
    top.close(null);
    return;
  }

  if(e.key === "Tab"){
    trapTab(e, top.modal);
  }
}, true);

const FOCUSABLE = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[href]",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function focusables(root){
  return Array.from(root.querySelectorAll(FOCUSABLE));
}

function trapTab(e, modal){
  const list = focusables(modal);
  if(!list.length) return;

  const first = list[0];
  const last = list[list.length - 1];

  if(e.shiftKey && document.activeElement === first){
    e.preventDefault();
    last.focus();
  }else if(!e.shiftKey && document.activeElement === last){
    e.preventDefault();
    first.focus();
  }
}

let seq = 0;

/**
 * Opens a modal and resolves with the chosen button's `value`, or null if the
 * user dismissed it.
 *
 * @param {object}      opts
 * @param {string}      opts.title
 * @param {string|Node} opts.body    text, or a node to adopt
 * @param {Array}       opts.buttons [{ label, value, kind }]
 * @param {string}      opts.size    "" | "sm"
 * @returns {Promise<any|null>}
 */
export function showModal({ title = "", body = "", buttons = [], size = "" } = {}){
  return new Promise(resolve => {
    const previouslyFocused = document.activeElement;
    const titleId = `modalTitle_${++seq}`;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = size ? `modal modal-${size}` : "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", titleId);

    const header = document.createElement("div");
    header.className = "modal-header";
    const titleEl = document.createElement("div");
    titleEl.className = "modal-title";
    titleEl.id = titleId;
    titleEl.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "iconbtn";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";
    header.append(titleEl, closeBtn);

    const bodyEl = document.createElement("div");
    bodyEl.className = "modal-body";
    if(body instanceof Node){
      bodyEl.appendChild(body);
    }else if(body !== "" && body != null){
      const msg = document.createElement("div");
      msg.className = "modal-message";
      msg.textContent = String(body);
      bodyEl.appendChild(msg);
    }

    const footer = document.createElement("div");
    footer.className = "modal-footer row gap";

    modal.append(header, bodyEl, footer);
    overlay.appendChild(modal);

    const entry = { modal, close };
    let settled = false;

    function close(value){
      if(settled) return;
      settled = true;

      const i = stack.indexOf(entry);
      if(i !== -1) stack.splice(i, 1);

      overlay.remove();
      if(!stack.length) document.body.classList.remove("modal-open");

      if(previouslyFocused && typeof previouslyFocused.focus === "function"){
        previouslyFocused.focus();
      }
      resolve(value);
    }

    for(const b of buttons){
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.kind ? `btn btn-${b.kind}` : "btn";
      btn.textContent = b.label;
      btn.addEventListener("click", () => close(b.value));
      footer.appendChild(btn);
    }

    closeBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if(e.target === overlay) close(null);
    });

    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");
    stack.push(entry);

    // An input is what the user came to fill in; otherwise aim at the primary
    // action, falling back to whatever is focusable.
    const input = modal.querySelector("input, textarea, select");
    const primary = modal.querySelector(".btn-primary, .btn-danger");
    (input || primary || focusables(modal)[0] || modal).focus();
    if(input && typeof input.select === "function") input.select();
  });
}

/** Message with a single acknowledgement. */
export function showAlert(message, { title = "Notice" } = {}){
  return showModal({
    title,
    body: message,
    size: "sm",
    buttons: [{ label: "OK", value: true, kind: "primary" }]
  }).then(() => undefined);
}

/** Yes/no. Resolves false on dismissal. */
export function showConfirm(message, { title = "Are you sure?", confirmLabel = "OK", danger = false } = {}){
  return showModal({
    title,
    body: message,
    size: "sm",
    buttons: [
      { label: "Cancel", value: false, kind: "ghost" },
      { label: confirmLabel, value: true, kind: danger ? "danger" : "primary" }
    ]
  }).then(v => v === true);
}

/** Single-line text input. Resolves null on dismissal or empty input. */
export function showPrompt(message, { title = "", value = "", placeholder = "", confirmLabel = "OK" } = {}){
  const inputId = `modalInput_${seq + 1}`;
  const wrap = document.createElement("div");

  if(message){
    const label = document.createElement("label");
    label.className = "modal-message";
    label.textContent = message;
    label.setAttribute("for", inputId);
    wrap.appendChild(label);
  }

  const input = document.createElement("input");
  input.className = "input";
  input.type = "text";
  input.id = inputId;
  input.value = value ?? "";
  input.placeholder = placeholder;
  wrap.appendChild(input);

  // Enter submits. Bound before the modal opens, so it is live immediately.
  input.addEventListener("keydown", (e) => {
    if(e.key !== "Enter") return;
    e.preventDefault();
    input.closest(".modal")?.querySelector(".btn-primary")?.click();
  });

  return showModal({
    title: title || message || "",
    body: wrap,
    size: "sm",
    buttons: [
      { label: "Cancel", value: null, kind: "ghost" },
      { label: confirmLabel, value: "__ok__", kind: "primary" }
    ]
  }).then(res => {
    if(res !== "__ok__") return null;
    const out = input.value.trim();
    return out === "" ? null : out;
  });
}

/** N-way choice. Resolves the chosen button's value, or null. */
export function showChoice({ title = "", body = "", buttons = [] } = {}){
  return showModal({ title, body, buttons });
}
