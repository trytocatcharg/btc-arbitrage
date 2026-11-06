/** node:test custom reporter: vitest-style summary box.
 *
 * The repo runs the Node built-in test runner (no vitest), whose bundled
 * reporters print either the full per-test spec or TAP, but never the
 * compact "Test Files / Tests / Duration" summary operators expect.
 * This reporter consumes the runner event stream and prints exactly that
 * box at the end of the run (details still come from the paired `spec`
 * reporter — see the `test` script in apps/bot/package.json).
 *
 * Suite vs test counting: node v23 test events carry no suite flag, but
 * the stream is a strict DFS — a parent emits `test:start`, then its
 * children, then its own pass/fail. An event whose frame saw at least one
 * child pass/fail is a suite (describe); otherwise it is a test. This
 * matches the runner's own tallies (verified against the spec reporter).
 *
 * Pairing: the runner matches each `--test-reporter` with a
 * `--test-reporter-destination` in order, both pointed at stdout.
 */
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

function pad(label) {
  return label.padStart(11);
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

export default async function* reporter(source) {
  const startedAtMs = Date.now();
  const startAt = new Date().toTimeString().slice(0, 8);
  const passedFiles = new Set();
  const failedFiles = new Set();
  const skippedFiles = new Set();
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  let suites = 0;
  const failures = [];
  /** DFS stack of open test frames: { name, nesting, children }. */
  const stack = [];

  function closeFrame(frame, outcome) {
    if (frame.children > 0) {
      // A frame with children is a suite (describe) — not a test.
      suites += 1;
      return;
    }
    if (outcome === "pass") pass += 1;
    else if (outcome === "fail") fail += 1;
    else skipped += 1;
  }

  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:start") {
      stack.push({
        name: data?.name,
        nesting: data?.nesting ?? 0,
        children: 0,
      });
      continue;
    }
    if (
      type === "test:pass" ||
      type === "test:fail" ||
      type === "test:skip"
    ) {
      // Pop siblings until the frame for this event is on top, crediting
      // each closed child to its parent.
      let frame = stack[stack.length - 1];
      while (
        stack.length > 0 &&
        !(
          frame.name === data?.name &&
          frame.nesting === (data?.nesting ?? 0)
        )
      ) {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) parent.children += 1;
        frame = parent;
      }
      if (!frame) continue;
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.children += 1;
      closeFrame(frame, type === "test:pass" ? "pass" : type === "test:fail" ? "fail" : "skip");
      if (data?.file) {
        if (type === "test:pass") passedFiles.add(data.file);
        else if (type === "test:fail") failedFiles.add(data.file);
        else skippedFiles.add(data.file);
      }
      if (type === "test:fail") {
        failures.push({
          name: data?.name ?? "(unnamed)",
          file: data?.file,
          error:
            data?.details?.error instanceof Error
              ? data.details.error.message
              : data?.details?.error
                ? String(data.details.error)
                : "unknown error",
        });
      }
    }
  }

  const totalFiles = passedFiles.size + failedFiles.size + skippedFiles.size;
  const totalTests = pass + fail + skipped;
  const ok = fail === 0;
  const accent = ok ? GREEN : RED;
  const counts = (failed, passed, total) =>
    ok
      ? `${accent}${BOLD}${passed} passed${RESET} ${DIM}(${total})${RESET}`
      : `${RED}${BOLD}${failed} failed${RESET} ${DIM}| ${passed} passed (${total})${RESET}`;

  let out = "\n";
  out += `${pad("Test Files")}  ${counts(failedFiles.size, passedFiles.size, totalFiles)}\n`;
  out += `${pad("Tests")}  ${counts(fail, pass, totalTests)}`;
  if (skipped > 0) out += ` ${DIM}| ${skipped} skipped${RESET}`;
  out += "\n";
  out += `${pad("Start at")}  ${startAt}\n`;
  out += `${pad("Duration")}  ${formatDuration(Date.now() - startedAtMs)}\n`;

  if (!ok) {
    out += `\n${RED}${BOLD}FAILURES${RESET}\n`;
    for (const failure of failures) {
      out += `${RED} ✖ ${failure.name}${RESET}\n`;
      if (failure.file) out += `   ${DIM}${failure.file}${RESET}\n`;
      out += `   ${failure.error.split("\n").join("\n   ")}\n`;
    }
  }

  yield out;
}
