// GoatCounter analytics (https://www.goatcounter.com): no cookies, no personal data.
//
// To turn it on, set GOATCOUNTER_CODE to your site code, i.e. the "mycode" in
// https://mycode.goatcounter.com. While it's empty nothing is loaded or sent.
export const GOATCOUNTER_CODE = "book-scrubber"; // the dashboard name from before the rename to Flipbook; only its owner sees it

const queue = [];
let ready = false;

export function initAnalytics() {
  if (!GOATCOUNTER_CODE) return;
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  s.onload = () => {
    ready = true;
    queue.splice(0).forEach((e) => send(e));
  };
  document.head.append(s);
}

function send(e) {
  try {
    window.goatcounter.count({ path: e.path, title: e.title, event: true });
  } catch {}
}

/**
 * Count an anonymous event, e.g. track("gif-made"). Never pass anything a
 * visitor typed: only fixed names, example titles, or bare hostnames.
 */
export function track(path, title = path) {
  if (!GOATCOUNTER_CODE) return;
  const e = { path, title };
  if (ready && window.goatcounter && window.goatcounter.count) send(e);
  else if (queue.length < 20) queue.push(e);
}
