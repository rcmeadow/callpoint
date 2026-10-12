import "./style.css";
import "./landing.css";
import { themeToggleHtml, wireThemeToggle } from "./theme";

const REPO = "https://github.com/rcmeadow/callpoint";

/** Keep ?theme= (used by video capture and shared links) when moving between pages. */
function withTheme(href: string): string {
  try {
    const t = new URLSearchParams(location.search).get("theme");
    return t ? `${href}?theme=${encodeURIComponent(t)}` : href;
  } catch {
    return href;
  }
}

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

document.querySelector<HTMLElement>("#landing")!.innerHTML = `
  <div class="lp">
    <header class="lp-top">
      <span class="lp-brand">Callpoint</span>
      ${themeToggleHtml}
    </header>

    <section class="lp-hero">
      <div class="lp-hero-text">
      <h1>Your incident just changed. Does your plan?</h1>
      <p class="lp-sub">Callpoint re-ranks your options every time a new fact lands, in about 200 ms. It tells you when two options are too close to call, and writes the decision trail for your postmortem.</p>
      <div class="lp-cta">
        <a class="btn primary" href="${withTheme("./demo/")}">Try the demo</a>
        <a class="btn" href="${REPO}" target="_blank" rel="noopener noreferrer">View on GitHub</a>
      </div>
      </div>
      <figure class="lp-video">
        <div class="lp-video-frame">
          <video src="./media/callpoint-landing.mp4" poster="./media/callpoint-landing-poster.jpg" width="1280" height="720" autoplay muted loop playsinline preload="metadata" aria-label="An 18 second screen recording of the Callpoint demo: new facts land, the options re-sort, and the call changes."></video>
        </div>
        <figcaption>A real recorded run: facts land, the call changes.</figcaption>
      </figure>
    </section>

    <ul class="lp-points">
      <li>${icon('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>')}<div><h2>Re-ranks as facts arrive</h2><p>Add what you just learned. Every option is judged again against your goals, and the list re-sorts.</p></div></li>
      <li>${icon('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>')}<div><h2>Knows when it's too close to call</h2><p>When the top options are within a small margin, it says so and hands the decision to you.</p></div></li>
      <li>${icon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>')}<div><h2>Leaves a decision trail</h2><p>Every fact, every re-rank and the final call, with timestamps, ready to paste into the postmortem.</p></div></li>
    </ul>

    <p class="lp-how"><strong>How it works.</strong> A decision model scores each option against your goals. Plain code ranks them, so every change is traceable. The model judges, the code decides.</p>

    <section class="lp-run card">
      <h2>Run it yourself</h2>
      <p>The public site replays a recorded run. To add your own facts, run it on your machine with your own TypeSafe key.</p>
      <pre><code>git clone ${REPO}
cd callpoint
npm install
npm run dev</code></pre>
      <p class="small muted">Bring your own TypeSafe key in <code>.env</code> or the macOS Keychain. Node 22.12 or newer. <a href="${REPO}#readme" target="_blank" rel="noopener noreferrer">Read the README</a> for setup, the local Clef comparison and how to write your own scenario.</p>
    </section>

    <footer class="lp-foot">
      <p class="small muted">Bring your own keys. Callpoint doesn't include or resell model access. Live mode calls TypeSafe's API with your own key, and your use is governed by TypeSafe's terms. Live facts and your scenario text are sent to TypeSafe's API (and to Ollama on your machine if the comparison is on). Don't paste secrets or customer data. Callpoint is not affiliated with or endorsed by TypeSafe or Cloudflare. MIT license.</p>
      <p class="lp-links">
        <a href="${REPO}" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href="https://x.com/rmeadow2" target="_blank" rel="noopener noreferrer">X @rmeadow2</a>
        <a href="${withTheme("./demo/")}">Demo</a>
      </p>
    </footer>
  </div>`;

wireThemeToggle();
