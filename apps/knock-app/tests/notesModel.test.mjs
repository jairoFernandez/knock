import test from "node:test";
import assert from "node:assert/strict";
import {
  filterNotes,
  noteStats,
  relativeTime,
  toggleTask,
  uniqueName,
  validateNoteName,
} from "../.test-dist/src/notesModel.js";

test("validateNoteName accepts normal names and rejects unsafe ones", () => {
  assert.equal(validateNoteName("Notas de día"), null);
  assert.equal(validateNoteName("deploy-checklist_v2"), null);
  for (const bad of ["", "  ", " x", "x ", ".env", "x.", "a/b", "a\\b", "a:b", "a\u0001", "x".repeat(81)]) {
    assert.notEqual(validateNoteName(bad), null, JSON.stringify(bad));
  }
});

test("uniqueName picks the first free suffix, ignoring case", () => {
  assert.equal(uniqueName("Untitled", []), "Untitled");
  assert.equal(uniqueName("Untitled", ["untitled"]), "Untitled 2");
  assert.equal(uniqueName("Untitled", ["Untitled", "Untitled 2"]), "Untitled 3");
});

test("filterNotes matches names case-insensitively", () => {
  const notes = [{ name: "Deploy" }, { name: "ideas" }, { name: "deploy prod" }];
  assert.deepEqual(filterNotes(notes, "DEP").map((n) => n.name), ["Deploy", "deploy prod"]);
  assert.equal(filterNotes(notes, "  ").length, 3);
});

test("toggleTask flips the nth checkbox in document order", () => {
  const src = "# Todo\n- [ ] one\n- [x] two\n* [ ] three";
  assert.equal(toggleTask(src, 0), "# Todo\n- [x] one\n- [x] two\n* [ ] three");
  assert.equal(toggleTask(src, 1), "# Todo\n- [ ] one\n- [ ] two\n* [ ] three");
  assert.equal(toggleTask(src, 2), "# Todo\n- [ ] one\n- [x] two\n* [x] three");
  assert.equal(toggleTask(src, 3), src);
});

test("toggleTask skips fenced code and handles nesting and ordered lists", () => {
  const src = "```md\n- [ ] not a task\n```\n  - [ ] nested\n1. [X] ordered\n> - [ ] quoted";
  assert.equal(toggleTask(src, 0), "```md\n- [ ] not a task\n```\n  - [x] nested\n1. [X] ordered\n> - [ ] quoted");
  assert.equal(toggleTask(src, 1), "```md\n- [ ] not a task\n```\n  - [ ] nested\n1. [ ] ordered\n> - [ ] quoted");
  assert.equal(toggleTask(src, 2), "```md\n- [ ] not a task\n```\n  - [ ] nested\n1. [X] ordered\n> - [x] quoted");
});

test("toggleTask: a ~~~ fence is not closed by ```", () => {
  const src = "~~~\n```\n- [ ] inside\n~~~\n- [ ] outside";
  assert.equal(toggleTask(src, 0), "~~~\n```\n- [ ] inside\n~~~\n- [x] outside");
});

test("toggleTask ignores bracket text that is not a task", () => {
  assert.equal(toggleTask("- [link](x)\n- [ ]tight", 0), "- [link](x)\n- [ ]tight");
});

test("noteStats counts words and lines", () => {
  assert.deepEqual(noteStats(""), { words: 0, lines: 0 });
  assert.deepEqual(noteStats("hola mundo\n\nadios"), { words: 3, lines: 3 });
});

test("relativeTime buckets ages", () => {
  const now = Date.UTC(2026, 10, 26, 12);
  assert.equal(relativeTime(now - 10_000, now), "now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d");
  assert.equal(relativeTime(now + 5_000, now), "now");
});

test("listContinuation continues bullets, numbers and tasks", async () => {
  const { listContinuation } = await import("../.test-dist/src/notesModel.js");
  assert.deepEqual(listContinuation("- uno"), { prefix: "- " });
  assert.deepEqual(listContinuation("  * dos"), { prefix: "  * " });
  assert.deepEqual(listContinuation("9. nueve"), { prefix: "10. " });
  assert.deepEqual(listContinuation("1) a"), { prefix: "2) " });
  assert.deepEqual(listContinuation("- [x] hecho"), { prefix: "- [ ] " });
  assert.deepEqual(listContinuation("> - cita"), { prefix: "> - " });
  assert.deepEqual(listContinuation("- "), { clear: true });
  assert.deepEqual(listContinuation("- [ ] "), { clear: true });
  assert.equal(listContinuation("texto"), null);
  assert.equal(listContinuation("-sin espacio"), null);
});
