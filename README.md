# Callpoint

An inspectable incident decision-support demo. **The model judges, the code decides.**

**Live site: https://callpoint.itsryanm.com** (the app is at [/demo/](https://callpoint.itsryanm.com/demo/)).
The public site is replay only: it plays a real recorded run at its recorded speed. Adding your
own facts (Live mode) needs the local server and your own TypeSafe key, so run it yourself for that.

Set the problem: what is happening, the options on the table, what a good outcome looks like,
and the hard rules. Add facts as they come in. Callpoint asks a decision model (TypeSafe Jev) to
judge every option against every goal as typed probabilities, and plain code ranks them. You
watch the call move, see why it moved, find out when it is too close to call, and leave with a
decision receipt for the postmortem.

What it gives you:

- **The problem card.** Start from the bundled checkout incident, or edit the incident, the
  options, the goals (with weights and levels), and the constraints right in the page. Export
  your version as JSON.
- **Live facts.** Type what you just learned. Each fact re-asks every question in one Jev
  request (around 200 ms to 1 s in testing here) and the ranking re-sorts. "Play demo" runs the
  scripted updates instead.
- **The call.** A banner above the ranking says what the code would do right now, with the
  "where we are going" line under it. When the top options are within the near-tie margin it
  turns amber, says "Too close to call", and shows the near-tie note under it instead.
- **The race.** Options ranked by weighted score, one bar each. Details shows the model's
  certainty (from its own probabilities) and the score per goal. Amber means too close to
  call. Options blocked by a hard constraint fold into compact struck-through rows below.
- **Where we were, where we are.** The starting ranking next to the current one, with the
  change in score and the facts that moved each option most.
- **Where we are going.** Code works out the single judgment change that would flip the top
  two, for example "Disable the smart-retries flag stays first unless its "Error reduction"
  falls below 0.80". When the top two are within the near-tie margin it says "Too close to
  call: this is a human decision."
- **Decision receipt.** A timestamped markdown log of every fact, the ranking after it, what
  moved and why, near-tie flags, every weights or constraints change, the final call, and the
  engine and model versions. Each section is ranked with the weights in force at that moment,
  so later tuning never rewrites an earlier recommendation. Copy it or download it as `.md`.
- **The code decides.** Weight sliders and constraint toggles re-rank the same judgments
  instantly, with 0 model calls.
- **Optional local comparison.** Turn on "Compare local model" (Cloudflare Clef via
  Ollama) to run the same questions on your own machine, side by side. It is off by
  default.

Replay mode plays a real recorded run at its recorded speed with no key and no local model,
so "Play demo" works on a static host. Live mode needs the local server and your key.

The app opens in a simple view: the problem, the call, the ranked options and Play demo, with a
short first-visit guide. "Show the engine" reveals everything above (timeline, timings, weights,
the compare and what-would-change cards, the receipt, the Clef switch). The choice is remembered
per browser, and `?view=full` opens the full view directly.

## Starter scenarios

Two starter problems ship with real recordings, and "Try another problem" in the simple view
switches between them. `?scenario=<id>` opens one directly.

| Scenario | What it is | Open it |
|---|---|---|
| `incident-triage` (default) | Checkout errors after a payments deploy: which response to run. | https://callpoint.itsryanm.com/demo/ |
| `feature-priority` | Which feature ships next: a product call for one team and one quarter. | https://callpoint.itsryanm.com/demo/?scenario=feature-priority |

Each has a scenario file and a recording in `scenarios/` (`<id>.json` and
`<id>.recording.json`).

## Quickstart

Needs Node 22.12+ (24 recommended; `.nvmrc` says 24).

1. `git clone https://github.com/rcmeadow/callpoint && cd callpoint && npm install`
2. `cp .env.example .env` and add your TypeSafe key (optional; see BYOK below). For the local
   column, install [Ollama](https://ollama.com) 0.35.1 or newer, start it, and pull Clef
   (about 11 to 12 GB): `ollama pull clef-flash:9b`, or over HTTP:
   `curl -X POST http://localhost:11434/api/pull -d '{"model":"clef-flash:9b"}'`.
3. `npm run dev`, then open http://localhost:5173 (the landing page). The app is at
   http://localhost:5173/demo/.

Without a key, use Replay mode. The local comparison only needs Ollama when you turn it on.

## Keys, terms and licenses

Bring your own keys. Callpoint doesn't include or resell model access. Live mode calls TypeSafe's API with your own key, and your use is governed by TypeSafe's terms. The local comparison runs Cloudflare's Clef (Apache 2.0) through Ollama on your machine, under their licenses. Callpoint is not affiliated with or endorsed by TypeSafe or Cloudflare. Provided as is under the MIT license.

Live facts and your scenario text are sent to TypeSafe's API (and to Ollama on your machine if the comparison is on). Don't paste secrets or customer data. Sessions live only in your browser tab and are gone on reload.

- TypeSafe terms: https://typesafe.ai/legal/mca and https://typesafe.ai/legal/acceptable-use-policy
- Clef model card: https://huggingface.co/Cloudflare/clef-flash
- Ollama license: https://github.com/ollama/ollama/blob/main/LICENSE

## Bring your own key

Callpoint never ships a key. The server loads yours once at startup and keeps it in memory:

1. `TYPESAFE_API_KEY` from the environment or `.env` (loaded with dotenv), or
2. on macOS, a Keychain item with the service name `TYPESAFE_API_KEY`:

   ```sh
   security add-generic-password -a "$USER" -s TYPESAFE_API_KEY -w
   ```

   (`-w` with no value prompts for it, so the key stays out of your shell history.)

The key never reaches the browser. The page only calls `/api/*` on the local server, and the
server makes every TypeSafe call. The Jev model is pinned to `jev-1.13.0` (`JEV_MODEL` in
`.env`), not `jev-latest`.

The API listens on `127.0.0.1` only, so nobody else on your network can spend your key. Set
`HOST` to change that (the server prints a warning when it is not loopback). It also rejects
browser requests whose `Origin` is not localhost or 127.0.0.1 on the dev, preview, or API port.

### Local engine options

- `LOCAL_ENGINE=clef` (default): Clef through Ollama's `/v1/systemone`, using the same
  System One adapter as Jev with a different base URL and model (`LOCAL_MODEL`, default
  `clef-flash:9b`). One batched request per distinct state, like Jev.
- `LOCAL_ENGINE=llm`: the older chat adapter that asks a small model (default `llama3.2:3b`)
  for one level per question. No probabilities, one request per question.

## Record a run for Replay

```sh
npm run record
```

This runs the whole scenario (incident triage unless you pass `--scenario <id>`) live through Jev (and the local engine if it is ready), writes
`scenarios/<id>.recording.json` with the real judgments and timings, then runs Jev a
second time with the cache cleared and checks that the ranking order matches at every update,
after collapsing near ties (see below). It prints every swap it collapsed.
Options: `--scenario <id>`, `--once` (skip the second run), `--no-local`.

Until you record one, Replay uses `scenarios/incident-triage.recording.SAMPLE.json`. That file
is marked `"synthetic": true` and the app labels it "sample data, not a real run": its
judgments and timings were written by hand (`npm run make-sample`), not produced by a model.

`npm run local-run` runs the scenario twice through the local engine only and prints timings
and the same order check.

## Write your own scenario

The quickest way: open "Edit the problem" in the app, change the incident, options, goals,
and constraints, press "Use this problem" to run it live, and "Export scenario JSON" to keep
it. Drop the exported file into `scenarios/` and it shows up in the starter picker with no
code change (in dev, reload the page; for a static build, rebuild). The shape:

```json
{
  "id": "my-incident",
  "title": "Short title",
  "goal": "What a good response achieves.",
  "incident": { "summary": "What is happening, in plain words." },
  "noun": "incident",
  "nearTieMargin": 0.02,
  "options": [{ "id": "a", "name": "Do A", "description": "What doing A involves." }],
  "criteria": [
    {
      "id": "impact",
      "name": "Error reduction",
      "question": "How much would carrying out the option reduce the errors?",
      "levels": ["Worst case described", "...", "Best case described"],
      "weight": 0.4
    }
  ],
  "constraints": [
    { "id": "data_loss", "name": "No data loss", "question": "Would the option risk losing data?", "threshold": 0.5 }
  ],
  "updates": [
    { "id": "u1", "at": "14:10", "title": "New fact", "text": "What was learned.", "affects": ["impact"] }
  ]
}
```

Tips:

- Write levels worst first, best last, and describe situations rather than degrees. Each
  criterion becomes one Score question per option; each constraint becomes one yes/no (Noul)
  question per option. A constraint blocks an option when P(yes) is at or above its threshold.
- Question ids are not sent to the model, so Callpoint puts the option's name and description and
  the criterion name into each question's instructions.
- `affects` matters. Each question only sees the updates that list its criterion or constraint,
  so an update re-asks just those questions and everything else comes from the cache.
- `incident.summary` is required: it is the problem text the app and the receipt show.
- `noun` (optional, default `"incident"`) is one plain word for what the scenario is about, such
  as `"decision"`. The app copy and the question wording use it ("Judge it against the goal,
  decision, and timeline"), so a non-incident scenario does not read like one.

## A sample receipt

From the real recording in `scenarios/incident-triage.recording.json` (Jev and Clef, replayed),
showing the first update and the final call. `npx tsx scripts/insight-demo.ts --receipt` prints
the whole thing.

```markdown
## Fact 1: Deploy diff reviewed

- Applied: 2026-10-12T16:56:02.922Z
- Timeline time: 14:10
- Source: scripted update

> The v2.31 diff turns on the new smart-retries feature flag by default. Since 14:02, retry traffic from payments-service to the primary database has tripled.

**Jev (TypeSafe)**: 185 ms, 10 of 30 questions re-asked, 1 request

- 1=. Roll back to v2.30, 0.883 (too close to call, gap 0.003)
- 1=. Disable the smart-retries flag, 0.880 (too close to call, gap 0.003)
- 3=. Fail over to a larger database, 0.514 (too close to call, gap 0.010)
- 3=. Ship a forward hotfix, 0.504 (too close to call, gap 0.010)
- X. Fail over checkout to us-west-2, 0.339 (blocked: No payment data loss)

Moves:
- Disable the smart-retries flag moved 3= to 1=: Error reduction rose, P(top level) 0.02 to 0.64 (score 0.6 to 2.6 of 3).
- Fail over to a larger database moved 2 to 3=: Error reduction fell, score 1.5 to 1.4 of 3.

**Clef (Cloudflare, local via Ollama)**: 3118 ms, 10 of 30 questions re-asked, 1 request

- 1. Fail over to a larger database, 0.582
- 2. Fail over checkout to us-west-2, 0.438
- 3. Ship a forward hotfix, 0.321
- X. Roll back to v2.30, 0.888 (blocked: No payment data loss)
- X. Disable the smart-retries flag, 0.881 (blocked: No payment data loss)

Moves:
- No change in order.

...

## Final call

- Jev (TypeSafe): **Disable the smart-retries flag** (0.889)
  - Where we are going: Disable the smart-retries flag is the only option not blocked by a constraint.
- Clef (Cloudflare, local via Ollama): **Disable the smart-retries flag** (0.868)
  - Where we are going: Disable the smart-retries flag stays first unless the chance it breaks "No payment data loss" reaches 0.5 (now 0.24). Then Fail over to a larger database takes the lead.

_Judgments come from the models. The ranking, constraint gates, near ties, and this receipt are plain code. Each section is ranked with the weights in force at that time; the final call uses the current weights._
```

At update 1 the top two are 0.003 apart, so they share "1=" and the race shows them in amber.
The next update settles it.

## How it works

- `src/engine/`: pure TypeScript. Question builder, judgment cache (keyed by a SHA-256 of
  engine, model, the question's state, and the question), runner, ranker with near ties, the
  "why it moved" diff, the then-vs-now compare, "where we are going", and the receipt. Unit
  tested with Vitest (`npm test`).
- Facts: scripted updates list the goals and constraints they can affect, so each one re-asks
  only those questions. A free-text fact has no such labels, so from the first live fact on
  every question sees the full timeline and is re-asked, in one request per engine.
- `src/server/`: Hono on Node. `/api/jev/step` sends each step's cache misses as one batched
  `systemOne` request per distinct state, through `@typesafe-ai/sdk` 0.6.0.
  `/api/:engine/facts` takes the (possibly edited) scenario plus the fact list, validates both,
  and runs the same runner and cache. `/api/local/step`
  does the same against Ollama's `/v1/systemone` with the Clef model (or, with
  `LOCAL_ENGINE=llm`, asks a chat model one question at a time).
- `src/web/`: Vite and TypeScript, no framework.

## Honest caveats

- **Scores and certainty are model judgments.** They are not validated outcome probabilities.

- **Jev output is not guaranteed bit-identical across runs.** TypeSafe's own cookbook shows
  small run-to-run noise on some questions (measured there on jev-1.12). Same inputs give the
  same ranking here because of three things: the model is pinned, judgments are cached by a
  hash of state and question, and the ranking is plain code. `npm run record` checks the order
  across two uncached runs, except for swaps inside a declared near tie; it does not promise
  identical probabilities.
- **Clef is a different model, not a local copy of Jev.** Cloudflare publishes Clef as open
  weights under Apache 2.0, and it answers the same System One question types. Expect the two
  columns to disagree in places; that disagreement is part of what the app shows. Clef has no
  documented seed or temperature setting, so treat its run-to-run stability as something to
  measure, not assume.
- **Local speed is this Mac only.** Clef timings depend on your hardware, memory, and Ollama
  version. Jev timings include the network round trip from one machine. Expect different
  numbers on yours.
- **Near ties are too close to call.** When options' totals are within the scenario's
  `nearTieMargin` (default 0.02), the code does not pick between them. Neighbours chain, so
  a-b and b-c within the margin form one group. The UI marks the group "too close to call"
  with the gap shown, gives it a shared rank like "1=", and lists it in scenario file order.
  The "why it moved" feed does not report a swap inside the group as a move, and the
  run-twice check collapses those swaps instead of failing. The real case behind this rule:
  in an earlier live Jev recording (since replaced), two uncached runs agreed at 5 of 6
  steps, and the one difference was the top two options at update 1, with totals of 0.883
  and 0.879. In the current recording the same pair sits at 0.883 and 0.880. Gaps that small
  are inside Jev's run-to-run noise, so calling them a ranking change would be false
  precision. Blocked options always sort last.
- The bundled scenario is a demo, not incident advice. Weights and constraints are yours.
- TypeSafe and Jev are named here only to say what the app calls. This project is not
  affiliated with or endorsed by TypeSafe.

## License

MIT. See [LICENSE](./LICENSE).
