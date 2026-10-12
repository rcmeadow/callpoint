# Reflex

Fast, auditable incident triage. **The model judges, the code decides.**

You give Reflex an incident, a few candidate responses, and a goal. A System One model
(TypeSafe Jev) scores every response against every goal criterion and returns typed
probabilities. Plain code ranks the responses: first a hard-constraint gate, then a weighted
sum. When a new incident update lands, only the judgments that update can affect are re-asked,
the ranking re-sorts on screen, and a "why it moved" feed names the judgment that moved each
option with its probability before and after.

The same questions also run through a local model (Ollama) in a second column, so you can
compare speed and agreement side by side.

What you see on screen:

- Two ranked columns (Jev and Local) that animate when the order changes.
- Per engine, per update: wall-clock latency in ms, how many questions were re-asked, and how
  many model requests that took.
- A "why it moved" feed.
- Weight sliders and constraint toggles. Changing them re-ranks the same judgments instantly
  and shows "0 model calls".
- Live and Replay modes. Replay plays a recorded run with its recorded timings, with no key
  and no local model needed.

## Quickstart

Needs Node 20 or newer.

1. `npm install`
2. `cp .env.example .env` and add your TypeSafe key (optional; see BYOK below). For the local
   column, install [Ollama](https://ollama.com), start it, and run `ollama pull llama3.2:3b`.
3. `npm run dev`, then open http://localhost:5173

Without a key or Ollama, use Replay mode. Each column tells you what it is missing.

## Bring your own key

Reflex never ships a key. The server loads yours once at startup and keeps it in memory:

1. `TYPESAFE_API_KEY` from the environment or `.env` (loaded with dotenv), or
2. on macOS, a Keychain item with the service name `TYPESAFE_API_KEY`:

   ```sh
   security add-generic-password -a "$USER" -s TYPESAFE_API_KEY -w
   ```

   (`-w` with no value prompts for it, so the key stays out of your shell history.)

The key never reaches the browser. The page only calls `/api/*` on the local server, and the
server makes every TypeSafe call. The Jev model is pinned to `jev-1.13.0` (`JEV_MODEL` in
`.env`), not `jev-latest`.

## Record a run for Replay

```sh
npm run record
```

This runs the whole scenario live through Jev (and the local model if Ollama is up), writes
`scenarios/incident-triage.recording.json` with the real judgments and timings, then runs Jev a
second time with the cache cleared and checks that the ranking order matches at every update.
Options: `--scenario <id>`, `--once` (skip the second run), `--no-local`.

Until you record one, Replay uses `scenarios/incident-triage.recording.SAMPLE.json`. That file
is marked `"synthetic": true` and the app labels it "sample data, not a real run": its
judgments and timings were written by hand (`npm run make-sample`), not produced by a model.

`npm run local-run` runs the scenario twice through the local model only and prints timings
and the same order check.

## Write your own scenario

Add a JSON file to `scenarios/`. It shows up in the scenario picker with no code change
(in dev, reload the page; for a static build, rebuild). The shape:

```json
{
  "id": "my-incident",
  "title": "Short title",
  "goal": "What a good response achieves.",
  "incident": { "summary": "What is happening, in plain words." },
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
- Question ids are not sent to the model, so Reflex puts the option's name and description and
  the criterion name into each question's instructions.
- `affects` matters. Each question only sees the updates that list its criterion or constraint,
  so an update re-asks just those questions and everything else comes from the cache.

## How it works

- `src/engine/`: pure TypeScript. Question builder, judgment cache (keyed by a SHA-256 of
  engine, model, the question's state, and the question), runner, ranker, and the "why it
  moved" diff. Unit tested with Vitest (`npm test`).
- `src/server/`: Hono on Node. `/api/jev/step` sends each step's cache misses as one batched
  `systemOne` request per distinct state, through `@typesafe-ai/sdk` 0.6.0. `/api/local/step`
  asks Ollama one question at a time with bounded concurrency (`LOCAL_CONCURRENCY`).
- `src/web/`: Vite and TypeScript, no framework.

## Honest caveats

- **Jev output is not guaranteed bit-identical across runs.** TypeSafe's own cookbook shows
  small run-to-run noise on some questions (measured there on jev-1.12). Same inputs give the
  same ranking here because of three things: the model is pinned, judgments are cached by a
  hash of state and question, and the ranking is plain code. `npm run record` checks the order
  across two uncached runs; it does not promise identical probabilities.
- **The local column is a simpler method.** It asks the local model for one level (or yes/no)
  per question as JSON and parses it. It has no probabilities, so its values are all or
  nothing, and a 3B model makes judgment calls a larger model would not. It is there for a
  speed and agreement comparison, not as an equal.
- **Latency numbers come from one machine and one network.** Jev timings include the network
  round trip; local timings depend on your hardware and Ollama settings. Expect different
  numbers on yours.
- **Ties are broken by file order.** When two options have the same weighted score (to
  1e-9), they keep the order they have in the scenario file, and the UI marks them "tied".
  Blocked options always sort last. The local engine's all-or-nothing values make ties more
  likely in its column.
- The bundled scenario is a demo, not incident advice. Weights and constraints are yours.
- TypeSafe and Jev are named here only to say what the app calls. This project is not
  affiliated with or endorsed by TypeSafe.

## License

MIT. See [LICENSE](./LICENSE).
