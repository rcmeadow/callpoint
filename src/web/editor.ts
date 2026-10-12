import { validateScenario, type Scenario } from "../engine/index";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function cloneScenario(s: Scenario): Scenario {
  return JSON.parse(JSON.stringify(s)) as Scenario;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

function uniqueId(base: string, taken: Set<string>, fallback: string): string {
  let id = slug(base) || fallback;
  let n = 2;
  const root = id;
  while (taken.has(id)) id = `${root}_${n++}`;
  taken.add(id);
  return id;
}

/** Fill in ids for new rows, drop update references to removed goals, then validate. */
export function finalizeDraft(draft: Scenario): Scenario {
  const s = cloneScenario(draft);
  const optionIds = new Set(s.options.map((o) => o.id).filter(Boolean));
  s.options.forEach((o, i) => {
    if (!o.id) o.id = uniqueId(o.name, optionIds, `option_${i + 1}`);
  });
  const targetIds = new Set([...s.criteria, ...s.constraints].map((c) => c.id).filter(Boolean));
  s.criteria.forEach((c, i) => {
    if (!c.id) c.id = uniqueId(c.name, targetIds, `goal_${i + 1}`);
    c.levels = c.levels.map((l) => l.trim()).filter(Boolean);
    c.weight = Number(c.weight);
  });
  s.constraints.forEach((k, i) => {
    if (!k.id) k.id = uniqueId(k.name, targetIds, `constraint_${i + 1}`);
    k.threshold = Number(k.threshold);
  });
  for (const o of s.options) if (!o.name.trim()) throw new Error("Every option needs a name.");
  for (const c of s.criteria) {
    if (!c.name.trim() || !c.question.trim()) throw new Error("Every goal needs a name and a question.");
    if (!(c.weight >= 0)) throw new Error(`Goal "${c.name}" needs a weight of 0 or more.`);
  }
  for (const k of s.constraints) {
    if (!k.name.trim() || !k.question.trim()) throw new Error("Every constraint needs a name and a question.");
    if (!(k.threshold > 0 && k.threshold <= 1)) throw new Error(`Constraint "${k.name}" needs a threshold above 0 and up to 1.`);
  }
  const ids = new Set([...s.criteria, ...s.constraints].map((c) => c.id));
  s.updates = s.updates.map((u) => ({ ...u, affects: u.affects.filter((a) => ids.has(a)) }));
  return validateScenario(s, "Your scenario");
}

function setPath(obj: unknown, path: string, value: string) {
  const parts = path.split(".");
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]!] as Record<string, unknown>;
  const last = parts[parts.length - 1]!;
  if (last === "levels") cur[last] = value.split("\n");
  else if (last === "weight" || last === "threshold" || last === "nearTieMargin") cur[last] = value === "" ? NaN : Number(value);
  else cur[last] = value;
}

export interface EditorHooks {
  onApply: (s: Scenario) => void;
  onExport: (s: Scenario) => void;
  onReset: () => void;
  liveAvailable: boolean;
}

/** A plain form editor for the problem. Mutates `draft` in place as people type. */
export function renderEditor(root: HTMLElement, draft: Scenario, hooks: EditorHooks, message = "") {
  const field = (label: string, path: string, value: string | number, kind: "input" | "textarea" | "number" = "input", extra = "") => {
    const v = esc(String(Number.isNaN(value) ? "" : value));
    const control =
      kind === "textarea"
        ? `<textarea data-path="${path}" rows="${extra || 2}">${v}</textarea>`
        : `<input data-path="${path}" ${kind === "number" ? `type="number" ${extra}` : 'type="text"'} value="${v}" />`;
    return `<label class="ed-field"><span>${label}</span>${control}</label>`;
  };
  root.innerHTML = `
    <div class="ed-grid">
      <section class="ed-block">
        <h3>The incident</h3>
        ${field("Title", "title", draft.title)}
        ${field("Goal", "goal", draft.goal, "textarea")}
        ${field("What is happening", "incident.summary", draft.incident.summary ?? "", "textarea", "4")}
        ${field("Near-tie margin", "nearTieMargin", draft.nearTieMargin ?? 0.02, "number", 'min="0" max="1" step="0.005"')}
      </section>
      <section class="ed-block">
        <h3>Options</h3>
        ${draft.options
          .map(
            (o, i) => `<div class="ed-row">
              ${field("Name", `options.${i}.name`, o.name)}
              ${field("What it involves", `options.${i}.description`, o.description, "textarea")}
              <button type="button" class="ghost small" data-remove="options.${i}" ${draft.options.length <= 2 ? "disabled" : ""}>Remove</button>
            </div>`,
          )
          .join("")}
        <button type="button" class="ghost" data-add="options">Add option</button>
      </section>
      <section class="ed-block">
        <h3>Goals</h3>
        ${draft.criteria
          .map(
            (c, i) => `<div class="ed-row">
              ${field("Name", `criteria.${i}.name`, c.name)}
              ${field("Question about the option", `criteria.${i}.question`, c.question, "textarea")}
              ${field("Weight", `criteria.${i}.weight`, c.weight, "number", 'min="0" max="1" step="0.05"')}
              ${field("Levels, worst first, one per line", `criteria.${i}.levels`, c.levels.join("\n"), "textarea", "4")}
              <button type="button" class="ghost small" data-remove="criteria.${i}" ${draft.criteria.length <= 1 ? "disabled" : ""}>Remove</button>
            </div>`,
          )
          .join("")}
        <button type="button" class="ghost" data-add="criteria">Add goal</button>
      </section>
      <section class="ed-block">
        <h3>Hard constraints</h3>
        ${draft.constraints
          .map(
            (k, i) => `<div class="ed-row">
              ${field("Name", `constraints.${i}.name`, k.name)}
              ${field("Yes/no question about the option", `constraints.${i}.question`, k.question, "textarea")}
              ${field("Block when P(yes) reaches", `constraints.${i}.threshold`, k.threshold, "number", 'min="0.05" max="1" step="0.05"')}
              <button type="button" class="ghost small" data-remove="constraints.${i}">Remove</button>
            </div>`,
          )
          .join("")}
        <button type="button" class="ghost" data-add="constraints">Add constraint</button>
      </section>
    </div>
    <p class="muted small">The scripted demo updates stay in place. If you remove a goal, updates stop pointing at it. Your edits run in Live mode.</p>
    ${message ? `<p class="ed-msg" role="alert">${esc(message)}</p>` : ""}
    <div class="ed-actions">
      <button type="button" class="primary" data-act="apply" ${hooks.liveAvailable ? "" : 'disabled title="Edits run the models, which needs the local server (npm run dev)."'}>Use this problem</button>
      <button type="button" data-act="export">Export scenario JSON</button>
      <button type="button" class="ghost" data-act="reset">Discard edits</button>
    </div>`;

  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-path]").forEach((el) =>
    el.addEventListener("input", () => setPath(draft, el.dataset.path!, el.value)),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      const [list, idx] = b.dataset.remove!.split(".");
      (draft as unknown as Record<string, unknown[]>)[list!]!.splice(Number(idx), 1);
      renderEditor(root, draft, hooks);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) =>
    b.addEventListener("click", () => {
      const list = b.dataset.add!;
      if (list === "options") draft.options.push({ id: "", name: "New option", description: "Describe what doing this involves." });
      if (list === "criteria")
        draft.criteria.push({ id: "", name: "New goal", question: "How well does the option meet this goal?", levels: ["Not at all", "Partly", "Mostly", "Fully"], weight: 0.1 });
      if (list === "constraints") draft.constraints.push({ id: "", name: "New constraint", question: "Would carrying out the option break this rule?", threshold: 0.5 });
      renderEditor(root, draft, hooks);
    }),
  );
  const tryFinal = (): Scenario | null => {
    try {
      return finalizeDraft(draft);
    } catch (err) {
      renderEditor(root, draft, hooks, err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  root.querySelector<HTMLButtonElement>('[data-act="apply"]')!.addEventListener("click", () => {
    const s = tryFinal();
    if (s) hooks.onApply(s);
  });
  root.querySelector<HTMLButtonElement>('[data-act="export"]')!.addEventListener("click", () => {
    const s = tryFinal();
    if (s) hooks.onExport(s);
  });
  root.querySelector<HTMLButtonElement>('[data-act="reset"]')!.addEventListener("click", () => hooks.onReset());
}
