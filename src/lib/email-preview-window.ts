/**
 * The email preview in its own browser window (owner, Nov 23, 2026): "email
 * preview opens in a new window which looks like an actual email instead of
 * pop up", because the preview dialog opened on top of the email dialog, a
 * second layer over the first.
 *
 * How a screen uses it, and why in this order:
 *   1. In the click handler, BEFORE the first `await`, call
 *      `openEmailPreviewWindow()`. A browser lets a page open a window only
 *      while it is answering a click; after an `await` (the preview request,
 *      a save) Safari and Firefox block it. The window opens at once and says
 *      the preview is being prepared.
 *   2. When the preview arrives, `show(...)` it; when it fails, `fail(...)`.
 *   3. It answers null when the browser blocked the window, and `show`
 *      answers false when the window is gone by the time the preview arrives
 *      (closed by the person or by a pop-up extension): either way the screen
 *      shows the old dialog instead, so the preview still appears.
 *
 * One window, reused: every preview opens in the same named window, so ten
 * previews are one window, not ten. The newest Preview owns it: a slower,
 * older request that answers late draws nothing.
 *
 * On a phone or tablet (a touch-first device) a "window" is a new tab that
 * covers the app, and a second Preview cannot bring it forward, so those
 * devices keep the dialog.
 *
 * The window closes with the app's page (closed, reloaded, signed out): a
 * real person's email is not left on screen after the session that asked.
 *
 * Safety: the email's HTML goes into a sandboxed frame with scripts off,
 * exactly as the dialog did; nothing from the email or its subject is ever
 * written into the window as HTML (text nodes only).
 *
 * Client-only, no imports: it runs in the browser bundle.
 */

export interface EmailPreviewContent {
  subject: string;
  htmlContent: string;
  /** Whose copy this is, or what the preview leaves out (shown above the email). */
  note?: string;
}

export interface EmailPreviewWindow {
  /** False when the window is gone or could not be drawn: show the dialog instead. */
  show(content: EmailPreviewContent): boolean;
  fail(message: string): void;
}

/** What the window itself remembers between previews. */
type PreviewWindow = Window & {
  /** The newest Preview's number: an older request that answers late is ignored. */
  __eaPreviewRequest?: number;
  /** The person's Desktop or Mobile choice, kept across previews. */
  __eaPreviewMobile?: boolean;
};

const WINDOW_NAME = "ea-sys-email-preview";
const WINDOW_FEATURES = "width=900,height=940";
const DESKTOP_WIDTH = 600;
const MOBILE_WIDTH = 375;

const STYLES = `
*{box-sizing:border-box}
body{margin:0;background:#f1f3f4;color:#202124;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.bar{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:12px;padding:10px 20px;background:#fff;border-bottom:1px solid #dadce0}
.bar-title{font-weight:600}
.bar-hint{color:#5f6368;font-size:12px}
.spacer{flex:1}
.toggle{display:inline-flex;border:1px solid #dadce0;border-radius:8px;padding:2px}
.toggle button{border:0;background:transparent;padding:5px 12px;border-radius:6px;font:inherit;font-size:12px;color:#3c4043;cursor:pointer}
.toggle button[aria-pressed="true"]{background:#e8f0fe;color:#1967d2;font-weight:600}
.wrap{max-width:860px;margin:20px auto;padding:0 16px 40px}
.card{background:#fff;border:1px solid #dadce0;border-radius:12px;overflow:hidden}
.head{padding:20px 24px 14px;border-bottom:1px solid #eceff1}
.subject{margin:0 0 12px;font-size:22px;font-weight:400;line-height:1.3;word-break:break-word}
.meta{display:flex;align-items:center;gap:12px}
.avatar{width:36px;height:36px;border-radius:50%;background:#00aade;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;flex:none}
.meta-text{min-width:0;color:#5f6368;font-size:13px}
.meta-text strong{color:#202124;font-weight:600}
.note{margin:12px 0 0;padding:8px 12px;border-radius:8px;background:#fef7e0;color:#7a5b00;font-size:12px}
.body{padding:20px 16px;background:#f8f9fa;display:flex;justify-content:center}
.frame{width:${DESKTOP_WIDTH}px;max-width:100%;background:#fff;border-radius:6px;box-shadow:0 1px 3px rgba(60,64,67,.2);overflow:hidden;transition:width .2s}
.frame.mobile{box-sizing:content-box;width:${MOBILE_WIDTH}px;border-radius:24px;border:10px solid #202124}
iframe{display:block;width:100%;height:600px;border:0}
.status{padding:60px 24px;text-align:center;color:#5f6368}
.status.error{color:#b3261e}
`;

/** A fresh document in the window: a fixed skeleton, the rest built as nodes. */
function resetDocument(win: Window, title: string): Document {
  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
  doc.close();
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = STYLES;
  doc.head.appendChild(style);
  // Esc closes the window, as it closed the dialog.
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape") win.close();
  });
  return doc;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function topBar(doc: Document, toggle?: HTMLElement): HTMLElement {
  const bar = el(doc, "div", "bar");
  bar.append(el(doc, "span", "bar-title", "Email preview"), el(doc, "span", "bar-hint", "Nothing has been sent"), el(doc, "span", "spacer"));
  if (toggle) bar.append(toggle);
  return bar;
}

function renderStatus(win: Window, message: string, isError: boolean): void {
  const doc = resetDocument(win, isError ? "Preview failed" : "Preparing the preview…");
  const wrap = el(doc, "div", "wrap");
  const card = el(doc, "div", "card");
  card.append(el(doc, "div", isError ? "status error" : "status", message));
  wrap.append(card);
  doc.body.append(topBar(doc), wrap);
}

function renderEmail(win: PreviewWindow, content: EmailPreviewContent): void {
  const subject = String(content.subject ?? "").trim() || "(no subject)";
  const doc = resetDocument(win, `Preview: ${subject}`);

  const frame = el(doc, "div", "frame");
  const iframe = el(doc, "iframe");
  iframe.title = "The email as it will be sent";
  // Scripts stay off (the sandbox grants no script permission). allow-same-origin
  // is what lets this window read the frame's height to fit it; the dialog's
  // frame carried the same flag.
  iframe.setAttribute("sandbox", "allow-same-origin");
  const fitHeight = () => {
    const inner = iframe.contentDocument?.documentElement;
    if (!inner) return;
    // Collapsed first: a root element is never shorter than its frame, so
    // without this the frame could grow and never shrink back.
    iframe.style.height = "0px";
    iframe.style.height = `${Math.max(inner.scrollHeight, 200)}px`;
  };
  iframe.addEventListener("load", fitHeight);
  iframe.srcdoc = content.htmlContent;
  frame.append(iframe);

  const toggle = el(doc, "div", "toggle");
  toggle.setAttribute("role", "group");
  toggle.setAttribute("aria-label", "Width");
  const desktop = el(doc, "button", undefined, "Desktop");
  const mobile = el(doc, "button", undefined, "Mobile");
  const choose = (isMobile: boolean) => {
    frame.classList.toggle("mobile", isMobile);
    desktop.setAttribute("aria-pressed", String(!isMobile));
    mobile.setAttribute("aria-pressed", String(isMobile));
    win.__eaPreviewMobile = isMobile;
    // The text reflows at the new width; measure once it has.
    win.setTimeout(fitHeight, 250);
  };
  for (const [button, isMobile] of [[desktop, false], [mobile, true]] as const) {
    button.type = "button";
    button.addEventListener("click", () => choose(isMobile));
    toggle.append(button);
  }
  choose(win.__eaPreviewMobile === true);

  const head = el(doc, "div", "head");
  head.append(el(doc, "h1", "subject", subject));
  const meta = el(doc, "div", "meta");
  const metaText = el(doc, "div", "meta-text");
  metaText.append(el(doc, "strong", undefined, "Preview"), doc.createTextNode(` · built ${new Date().toLocaleString()}`));
  meta.append(el(doc, "div", "avatar", "@"), metaText);
  head.append(meta);
  if (content.note) head.append(el(doc, "p", "note", content.note));

  const body = el(doc, "div", "body");
  body.append(frame);
  const card = el(doc, "div", "card");
  card.append(head, body);
  const wrap = el(doc, "div", "wrap");
  wrap.append(card);
  doc.body.append(topBar(doc, toggle), wrap);
}

/** A phone or tablet: a "window" there is a tab over the app. */
function isTouchFirstDevice(): boolean {
  try {
    return window.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

/** The window the newest Preview drew into, so the page can close it when it goes. */
let currentWindow: PreviewWindow | null = null;
let closesWithThePage = false;

/**
 * Opens (or reuses) the preview window, showing that the preview is on its
 * way. Call it in the click handler before any `await`. Null when the browser
 * blocked it, or on a touch-first device: show the dialog instead.
 */
export function openEmailPreviewWindow(): EmailPreviewWindow | null {
  if (typeof window === "undefined") return null;
  if (isTouchFirstDevice()) return null;
  let win: PreviewWindow | null = null;
  try {
    win = window.open("", WINDOW_NAME, WINDOW_FEATURES);
    if (!win) return null;
    renderStatus(win, "Preparing the preview…", false);
  } catch {
    // Blocked, or the reused window was taken to another site (its document
    // is then out of reach): the dialog takes over.
    return null;
  }
  win.focus();
  const target = win;
  const request = (target.__eaPreviewRequest ?? 0) + 1;
  target.__eaPreviewRequest = request;
  currentWindow = target;
  if (!closesWithThePage) {
    closesWithThePage = true;
    window.addEventListener("pagehide", () => {
      try {
        currentWindow?.close();
      } catch {
        // Already gone.
      }
    });
  }
  /** True when drawn. False when the window is gone, superseded, or the draw failed. */
  const draw = (what: string, render: () => void): boolean => {
    if (target.closed) return false;
    try {
      // A newer Preview owns the window now: this answer is stale. Not a
      // failure to fall back from (the newer preview is on screen).
      if (target.__eaPreviewRequest !== request) return true;
      render();
      target.focus();
      return true;
    } catch (err) {
      console.error(`[email-preview-window] could not ${what}`, err);
      return false;
    }
  };
  return {
    show: (content) => draw("show the preview", () => renderEmail(target, content)),
    fail: (message) => {
      draw("show the failure", () => renderStatus(target, message, true));
    },
  };
}
