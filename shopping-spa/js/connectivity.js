// Is Drive reachable? One source of truth, fed by two kinds of evidence: the
// browser's own online/offline events, and whether Drive calls actually
// succeed. The second matters more. In a shop navigator.onLine is usually
// still true while every request quietly hangs, so believing it alone would
// leave the app pretending to be online for the whole trip.

const BACKOFF_LADDER_MS = [15_000, 30_000, 60_000];

/** Thrown when a Drive call could not reach the network at all. */
export class OfflineError extends Error {
  constructor(message = "Offline"){
    super(message);
    this.name = "OfflineError";
  }
}

/**
 * A failure counts as evidence of being offline only when no HTTP response
 * arrived. A 403 or a 404 proves the network works, and must keep surfacing as
 * the real error it is rather than hiding behind an offline banner.
 */
export function isNetworkError(err){
  if(!err) return false;
  if(err instanceof OfflineError) return true;
  if(err.name === "AbortError" || err.name === "TimeoutError") return true;
  return err instanceof TypeError;
}

export function createConnectivity({
  nav = globalThis.navigator,
  clock = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  addListener = (type, fn) => globalThis.addEventListener?.(type, fn)
} = {}){
  let backoffUntil = 0;
  let rung = -1;
  let timer = null;
  const subscribers = new Set();

  function isOffline(){
    if(nav && nav.onLine === false) return true;
    return clock() < backoffUntil;
  }

  let last = isOffline();

  function emit(){
    const cur = isOffline();
    if(cur === last) return;
    last = cur;
    // Copy first: a subscriber is allowed to unsubscribe from inside its own
    // callback, which would otherwise mutate the set mid-iteration.
    for(const fn of [...subscribers]) fn(cur);
  }

  // The backoff expires by the clock, not by anything calling in, so recovery
  // would go unannounced without a timer. app.js pushes pending ticks on that
  // announcement, so it has to be real rather than discovered on the next poll.
  function arm(){
    if(timer !== null){ clearTimer(timer); timer = null; }
    const ms = backoffUntil - clock();
    if(ms > 0){
      timer = setTimer(() => { timer = null; emit(); }, ms);
    }
  }

  function clear(){
    backoffUntil = 0;
    rung = -1;
    arm();
    emit();
  }

  function noteSuccess(){
    clear();
  }

  function noteFailure(err){
    if(!isNetworkError(err)){
      // Drive answered, so the network is fine even though the call failed.
      noteSuccess();
      return;
    }
    rung = Math.min(rung + 1, BACKOFF_LADDER_MS.length - 1);
    backoffUntil = clock() + BACKOFF_LADDER_MS[rung];
    arm();
    emit();
  }

  function subscribe(fn){
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  addListener("online", clear);
  addListener("offline", emit);

  return { isOffline, noteSuccess, noteFailure, subscribe };
}

/** What the app uses. Tests build their own with createConnectivity(). */
export const Connectivity = createConnectivity();
