/**
 * Consent popup — asks the user to approve or deny a site connection.
 *
 * Opened by the background service worker via chrome.windows.create().
 * Sends the decision back via chrome.runtime.sendMessage().
 */

import { render } from "preact";
import { ext } from "../shared/browser.js";

function ConsentApp() {
  const params = new URLSearchParams(location.search);
  const origin = params.get("origin") ?? "unknown";

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    hostname = origin;
  }

  function respond(approved: boolean) {
    ext.runtime.sendMessage(
      { type: "_consentResponse", origin, approved },
      () => {
        // Popup will be closed by the background script.
        // Fallback: close ourselves if the background didn't.
        setTimeout(() => window.close(), 300);
      },
    );
  }

  return (
    <div class="consent">
      <img class="consent__icon" src="/icons/icon-128.png" alt="Keyquill" />
      <h1>Connection Request</h1>
      <div class="origin">{hostname}</div>
      <div class="origin-full">{origin}</div>
      <p class="description">
        This site wants to send requests to LLM providers using your API keys stored in Keyquill.
        Your keys will never be shared with the site.
      </p>
      <div class="actions">
        <button class="btn btn--secondary" onClick={() => respond(false)}>
          Deny
        </button>
        <button class="btn btn--primary" onClick={() => respond(true)}>
          Allow
        </button>
      </div>
      <p class="warning">
        You can revoke access at any time from the Keyquill extension popup.
      </p>
    </div>
  );
}

render(<ConsentApp />, document.getElementById("app")!);
