import type { RunSummary, TraceDiff, Verdict } from "./diff.js";
import { billedNote, change, describeDivergence, money, pct } from "./format.js";

/**
 * A single self-contained HTML page for one replay run: the summary, then every run with its tool path, argument
 * changes and both answers side by side. No scripts or external files, so it can be attached to a PR or a CI
 * artifact and opened anywhere.
 */

export interface ReportInput {
  runId: string;
  createdAt: number;
  changes: Record<string, unknown>;
  summary: RunSummary;
  diffs: TraceDiff[];
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const ORDER: Verdict[] = ["changed", "error", "unreplayable", "same"];

function badge(v: Verdict): string {
  return `<span class="badge ${esc(v)}">${esc(v)}</span>`;
}

function describeChanges(c: Record<string, unknown>): string {
  const parts = Object.entries(c).map(([k, v]) => {
    const value = typeof v === "string" ? v : JSON.stringify(v);
    return `<code>${esc(k)}</code> ${esc(value.length > 120 ? `${value.slice(0, 120)}…` : value)}`;
  });
  return parts.length ? parts.join(" · ") : "no change (a noise check: the recording replayed as it was)";
}

function path(names: string[]): string {
  return names.length ? names.map((n) => `<code>${esc(n)}</code>`).join(" → ") : "<em>no tool calls</em>";
}

function runSection(d: TraceDiff, i: number): string {
  const args = d.tools.argChanges
    .map(
      (a) =>
        `<li><code>${esc(a.name)}</code> #${a.candidateStep + 1}: ${a.changes
          .slice(0, 5)
          .map(
            (c) =>
              `<code>${esc(c.path || "(input)")}</code> ${esc(JSON.stringify(c.before) ?? "∅")} → ${esc(JSON.stringify(c.after) ?? "∅")}`,
          )
          .join("; ")}</li>`,
    )
    .join("");
  const j = d.final.judge;
  const answerLine = j
    ? `Judge (${esc(j.model)}): <strong>${esc(j.verdict)}</strong>. ${esc(j.reason)}${j.lost.length ? ` Lost: ${esc(j.lost.join("; "))}` : ""}`
    : `Key facts ${pct(d.final.factOverlap)} shared, wording ${pct(d.final.similarity)} alike${
        d.final.missingFacts.length ? `. Lost: ${esc(d.final.missingFacts.slice(0, 8).join(", "))}` : ""
      }${d.final.judgeError ? `. Judge failed: ${esc(d.final.judgeError)}` : ""}`;
  const tiers = Object.entries(d.replayTiers)
    .map(([t, n]) => `${esc(t)} ${n}`)
    .join(", ");
  return `<details class="run ${esc(d.verdict)}"${d.verdict === "changed" && i < 20 ? " open" : ""}>
<summary>${badge(d.verdict)} <span class="task">${esc(d.task || d.baselineId)}</span> <span class="why">${esc(describeDivergence(d))}</span></summary>
<div class="body">
<p class="ids"><code>${esc(d.baselineId)}</code> → <code>${esc(d.candidateId)}</code> · cost ${money(d.costUsd.baseline)} → ${money(d.costUsd.candidate)}${change(d.costUsd.baseline, d.costUsd.candidate)} · time ${(d.latencyMs.baseline / 1000).toFixed(1)}s → ${(d.latencyMs.candidate / 1000).toFixed(1)}s${esc(billedNote(d))}${tiers ? ` · tool calls answered by ${tiers}` : ""}</p>
<table class="paths"><tr><th>Recorded</th><td>${path(d.tools.baseline)}</td></tr><tr><th>Replay</th><td>${path(d.tools.candidate)}</td></tr></table>
${args ? `<p>Argument changes:</p><ul>${args}</ul>` : ""}
<p class="verdict-line">${answerLine}</p>
<div class="answers"><div><h4>Recorded answer <small>(${esc(d.final.baselineStop)})</small></h4><pre>${esc(d.final.baselineText) || "<em>(empty)</em>"}</pre></div><div><h4>Replay answer <small>(${esc(d.final.candidateStop)})</small></h4><pre>${esc(d.final.candidateText) || "<em>(empty)</em>"}</pre></div></div>
</div></details>`;
}

export function renderReport(r: ReportInput): string {
  const s = r.summary;
  const v = s.verdicts;
  const sorted = [...r.diffs].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  const repeats = s.runs > s.traces ? Math.round(s.runs / s.traces) : 1;
  const flaky = s.flaky.length
    ? `<section><h2>Flaky traces</h2><p>These came out the same in some replays and changed in others, so a change on them may be noise.</p><ul>${s.flaky
        .map(
          (f) =>
            `<li><code>${esc(f.baselineId)}</code> changed ${f.changed} of ${f.same + f.changed}: ${esc(f.task)}</li>`,
        )
        .join("")}</ul></section>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TraceWarp ${esc(r.runId)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e4e3de;--same:#2f7d4f;--changed:#b4541a;--unrep:#6d5bb5;--error:#b42318;--code:#f2f1ec}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#a09f99;--card:#1f1f1d;--line:#34332f;--same:#6cc38f;--changed:#f0a15f;--unrep:#a99bf0;--error:#f08a80;--code:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.sub{color:var(--muted);margin:0 0 20px}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.card span{color:var(--muted);font-size:13px}
.card.same b{color:var(--same)}.card.changed b{color:var(--changed)}.card.unreplayable b{color:var(--unrep)}.card.error b{color:var(--error)}
.badge{display:inline-block;min-width:96px;text-align:center;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;border-radius:999px;padding:2px 8px;border:1px solid currentColor}
.badge.same{color:var(--same)}.badge.changed{color:var(--changed)}.badge.unreplayable{color:var(--unrep)}.badge.error{color:var(--error)}
details.run{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:8px 0}details.run>summary{cursor:pointer;padding:10px 14px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;list-style:none}
details.run>summary::-webkit-details-marker{display:none}.task{font-weight:600;flex:1 1 300px}.why{color:var(--muted);font-size:13px}
.body{padding:0 14px 14px;border-top:1px solid var(--line)}.ids{color:var(--muted);font-size:13px}table.paths{border-collapse:collapse;width:100%}
table.paths th{text-align:left;color:var(--muted);font-weight:500;width:90px;padding:4px 0;vertical-align:top}table.paths td{padding:4px 0;overflow-wrap:anywhere}
.answers{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:700px){.answers{grid-template-columns:1fr}}
.answers h4{margin:8px 0 4px;font-size:13px;color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);border-radius:8px;padding:10px;margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:420px;overflow:auto}
.verdict-line{font-size:14px}footer{color:var(--muted);font-size:12px;margin-top:32px}
</style></head><body><main>
<h1>Replay ${esc(r.runId)}</h1>
<p class="sub">${new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC · ${describeChanges(r.changes)}</p>
<div class="cards">
<div class="card same"><b>${v.same}</b><span>same</span></div>
<div class="card changed"><b>${v.changed}</b><span>changed</span></div>
<div class="card unreplayable"><b>${v.unreplayable}</b><span>unreplayable</span></div>
<div class="card error"><b>${v.error}</b><span>error</span></div>
<div class="card"><b>${money(s.costUsd.baseline)} → ${money(s.costUsd.candidate)}</b><span>cost${esc(change(s.costUsd.baseline, s.costUsd.candidate))}${s.excluded ? `, ${s.runs - s.excluded} comparable runs` : ""}</span></div>
<div class="card"><b>${(s.latencyMs.baseline / 1000).toFixed(1)}s → ${(s.latencyMs.candidate / 1000).toFixed(1)}s</b><span>time${esc(change(s.latencyMs.baseline, s.latencyMs.candidate))}</span></div>
</div>
<p class="sub" style="margin-top:12px">${s.traces} traces${repeats > 1 ? ` × ${repeats} replays` : ""} · tool path changed ${pct(s.toolPathChanged)} · arguments drifted ${pct(s.argumentsDrifted)} · final answer changed ${pct(s.answerChanged)}${
    s.judge.judged || s.judge.failed
      ? ` · judge: ${s.judge.judged} ruled, ${s.judge.failed} failed (kept key facts), cost ${money(s.judge.costUsd)}`
      : ""
  }</p>
${flaky}
<h2>Runs</h2>
${sorted.map(runSection).join("\n")}
<footer>Made by TraceWarp. Unreplayable means the replayed agent made a tool call the recording could not answer, so the run was stopped instead of guessed.</footer>
</main></body></html>
`;
}

/**
 * Recorded text in a Markdown cell or line: no table breaks, HTML, links or @mentions (a job summary or PR
 * comment would otherwise ping people or render markup from recorded traffic).
 */
export function mdText(t: string): string {
  return t
    .replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`)
    .replace(/@/g, "@\u200b")
    .replace(/(https?):\/\//gi, "$1\u200b://");
}

/** A short Markdown summary, for a GitHub job summary or a PR comment. */
export function renderMarkdown(r: ReportInput): string {
  const s = r.summary;
  const v = s.verdicts;
  const changes = Object.keys(r.changes).length
    ? Object.entries(r.changes)
        .map(
          ([k, val]) =>
            `\`${k}\` ${mdText(
              String(typeof val === "string" ? val : JSON.stringify(val))
                .replace(/\s+/g, " ")
                .slice(0, 160),
            )}`,
        )
        .join(", ")
    : "no change (noise check)";
  const cell = (t: string) => mdText(t.replace(/\s+/g, " ").slice(0, 120));
  const rows = [...r.diffs]
    .sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict))
    .filter((d) => d.verdict !== "same")
    .slice(0, 25)
    .map(
      (d) =>
        `| ${d.verdict} | ${cell(d.task || d.baselineId)} | ${cell(describeDivergence(d))} | ${cell(d.final.judge?.reason ?? (d.final.changed ? `lost ${d.final.missingFacts.slice(0, 4).join(", ")}` : ""))} |`,
    );
  return [
    `### TraceWarp replay ${r.runId}`,
    "",
    `Change: ${changes}`,
    "",
    `**${v.same} same · ${v.changed} changed · ${v.unreplayable} unreplayable · ${v.error} error** across ${s.traces} traces${s.runs > s.traces ? ` (${Math.round(s.runs / s.traces)} replays each)` : ""}.`,
    `Cost ${money(s.costUsd.baseline)} → ${money(s.costUsd.candidate)}${change(s.costUsd.baseline, s.costUsd.candidate)}, time ${(s.latencyMs.baseline / 1000).toFixed(1)}s → ${(s.latencyMs.candidate / 1000).toFixed(1)}s${change(s.latencyMs.baseline, s.latencyMs.candidate)}.`,
    ...(s.judge.judged || s.judge.failed
      ? [
          "",
          `Judge: ${s.judge.judged} answers ruled, ${s.judge.failed} failed (kept the key-facts result), cost ${money(s.judge.costUsd)}.`,
        ]
      : []),
    ...(s.flaky.length ? ["", `${s.flaky.length} flaky traces (same in some replays, changed in others).`] : []),
    ...(rows.length
      ? ["", "| Verdict | Task | Where it diverged | Answer |", "| --- | --- | --- | --- |", ...rows]
      : ["", "Every run behaved the same as its recording."]),
    "",
  ].join("\n");
}
