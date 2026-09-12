// Focus mode: hide the app chrome (topbar + lists sidebar) and give the whole
// viewport to the active list.
//
// The preference is remembered per device, but it is only *applied* while a list
// is open. The toggle lives in the list header, so keeping it tied to the list
// view guarantees the way out is always on screen.

const KEY = "shopping.focusMode";

let wanted = read();

function read(){
  try{ return localStorage.getItem(KEY) === "1"; }
  catch{ return false; }
}

function write(on){
  try{ localStorage.setItem(KEY, on ? "1" : "0"); }
  catch{ /* storage blocked: the choice holds for this session only */ }
}

export function isFocusWanted(){
  return wanted;
}

export function setFocusWanted(on){
  wanted = !!on;
  write(wanted);
}

export function toggleFocus(){
  setFocusWanted(!wanted);
}

/** Applies the preference to the document. Focus mode needs a list to focus on. */
export function applyFocus(hasList){
  document.body.classList.toggle("focus-mode", wanted && !!hasList);
}
