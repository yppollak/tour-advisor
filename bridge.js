/* The bridge between the Tour Advisor site and this extension.
 *
 * A web page cannot call chrome.runtime, and the extension cannot be reached
 * from the page without either a hard-coded extension id or a relay. This is the
 * relay: a content script that runs only on Tour Advisor, announces that the
 * extension is installed, and forwards a refresh request to the background.
 *
 * It carries no data in either direction — only "I am here" and "please sync".
 * Everything the sync actually reads and posts happens in runner.js, on the
 * user's own SecurePSA session, exactly as it does when the toolbar icon is
 * clicked. Nothing here can read the page, and nothing on the page can reach
 * SecurePSA through it.
 */

const SITE = "tour-advisor";        // what the page stamps its messages with
const EXT = "tour-advisor-sync";    // what this script stamps its replies with

// targetOrigin "*": the message goes to this same window and nowhere else, the
// page verifies event.source === window before trusting it, and the payload is
// only "the extension is installed". Nothing here is worth pinning an origin for.
function announce(){
  window.postMessage({ source: EXT, type: "hello",
                       version: chrome.runtime.getManifest().version }, "*");
}

window.addEventListener("message", event => {
  // Only this page, in this frame. A message from an iframe or another origin is
  // not ours, whatever it claims to be.
  if(event.source !== window) return;
  const d = event.data;
  if(!d || d.source !== SITE) return;

  if(d.type === "ping"){ announce(); return; }

  if(d.type === "sync"){
    chrome.runtime.sendMessage({ action: "sync" }, () => {
      // The reply tells the page the request landed, not that the sync finished —
      // that happens in the runner tab, which the user can watch.
      const err = chrome.runtime.lastError;
      window.postMessage({ source: EXT, type: err ? "error" : "started",
                           message: err ? err.message : null }, "*");
    });
  }
});

// The page may load before or after this script, so say hello now and answer
// any ping later.
announce();
