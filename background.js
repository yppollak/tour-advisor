// The sync always runs in runner.html, whether it was started from the toolbar
// icon or from the Refresh button on the site. One code path, and the user can
// watch the log either way.
const PAGE = chrome.runtime.getURL("runner.html");

async function openRunner(auto){
  const existing = await chrome.tabs.query({ url: PAGE + "*" });
  if(existing.length){
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    // Already open and possibly mid-run; tell it rather than reloading over the top.
    if(auto) chrome.tabs.sendMessage(existing[0].id, { action: "sync" }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url: auto ? PAGE + "?auto=1" : PAGE });
}

chrome.action.onClicked.addListener(() => openRunner(false));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if(msg && msg.action === "sync"){ openRunner(true); reply({ ok: true }); }
  return false;
});
