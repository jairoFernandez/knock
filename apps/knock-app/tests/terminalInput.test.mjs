import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveInputTarget,
  shouldRestartOnInput,
  getTerminalKeyAction,
  cleanCopiedText,
  clampMenuPosition,
  shouldOpenLink,
  isOpenableUrl,
} from "../.test-dist/src/terminalInput.js";

// -------- input routing (first-terminal hang) --------

function route(overrides = {}) {
  return {
    sessionId: "sid",
    spawned: false,
    outputSeen: false,
    exited: false,
    ...overrides,
  };
}

test("drops keys typed before the shell exists", () => {
  assert.equal(resolveInputTarget(route()), null);
  assert.equal(resolveInputTarget(route({ sessionId: null, spawned: true })), null);
});

test("answers terminal queries that arrive before spawn resolves", () => {
  // The shell asked for the cursor position (ESC[6n) and is blocked until
  // xterm's reply reaches it; terminal_spawn has not returned yet.
  assert.equal(resolveInputTarget(route({ outputSeen: true })), "sid");
});

test("routes input once the spawn resolved", () => {
  assert.equal(resolveInputTarget(route({ spawned: true })), "sid");
});

test("never writes into an exited session", () => {
  assert.equal(
    resolveInputTarget(route({ spawned: true, outputSeen: true, exited: true })),
    null,
  );
});

test("Enter restarts an exited pane, other keys do not", () => {
  assert.equal(shouldRestartOnInput(true, "\r"), true);
  assert.equal(shouldRestartOnInput(true, "\n"), true);
  assert.equal(shouldRestartOnInput(true, "a"), false);
  assert.equal(shouldRestartOnInput(false, "\r"), false);
});

// -------- keyboard shortcuts --------

function key(k, mods = {}) {
  return {
    type: "keydown",
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

const mac = (hasSelection = false) => ({ isMac: true, hasSelection });
const pc = (hasSelection = false) => ({ isMac: false, hasSelection });

test("mac: Cmd+C copies only with a selection", () => {
  assert.equal(getTerminalKeyAction(key("c", { metaKey: true }), mac(true)), "copy");
  assert.equal(getTerminalKeyAction(key("c", { metaKey: true }), mac(false)), null);
});

test("mac: Cmd+V is left to the native paste event", () => {
  assert.equal(getTerminalKeyAction(key("v", { metaKey: true }), mac()), null);
});

test("mac: Cmd+K clears, Cmd+F finds, Cmd+A selects all", () => {
  assert.equal(getTerminalKeyAction(key("k", { metaKey: true }), mac()), "clear");
  assert.equal(getTerminalKeyAction(key("f", { metaKey: true }), mac()), "find");
  assert.equal(getTerminalKeyAction(key("a", { metaKey: true }), mac()), "selectAll");
});

test("mac: Ctrl+C still reaches the shell", () => {
  assert.equal(getTerminalKeyAction(key("c", { ctrlKey: true }), mac(true)), null);
});

test("pc: Ctrl+C copies with a selection, otherwise is SIGINT", () => {
  assert.equal(getTerminalKeyAction(key("c", { ctrlKey: true }), pc(true)), "copy");
  assert.equal(getTerminalKeyAction(key("c", { ctrlKey: true }), pc(false)), null);
});

test("pc: Ctrl+Shift+C/V/F/K/A map to terminal actions", () => {
  const s = { ctrlKey: true, shiftKey: true };
  assert.equal(getTerminalKeyAction(key("C", s), pc()), "copy");
  assert.equal(getTerminalKeyAction(key("V", s), pc()), "paste");
  assert.equal(getTerminalKeyAction(key("F", s), pc()), "find");
  assert.equal(getTerminalKeyAction(key("K", s), pc()), "clear");
  assert.equal(getTerminalKeyAction(key("A", s), pc()), "selectAll");
});

test("pc: plain Ctrl+V/K/A stay with the shell", () => {
  assert.equal(getTerminalKeyAction(key("v", { ctrlKey: true }), pc()), null);
  assert.equal(getTerminalKeyAction(key("k", { ctrlKey: true }), pc()), null);
  assert.equal(getTerminalKeyAction(key("a", { ctrlKey: true }), pc()), null);
});

test("ignores keyup/keypress and Alt combos", () => {
  assert.equal(
    getTerminalKeyAction({ ...key("c", { metaKey: true }), type: "keyup" }, mac(true)),
    null,
  );
  assert.equal(
    getTerminalKeyAction(key("c", { metaKey: true, altKey: true }), mac(true)),
    null,
  );
});

// -------- copy / menu / links --------

test("strips the padding xterm adds to copied rows", () => {
  assert.equal(cleanCopiedText("ls -la   \nfoo\t \r\nbar"), "ls -la\nfoo\nbar");
  assert.equal(cleanCopiedText("  indented"), "  indented");
});

test("keeps a context menu inside the viewport", () => {
  const menu = { width: 200, height: 300 };
  const vp = { width: 800, height: 600 };
  assert.deepEqual(clampMenuPosition(100, 100, menu, vp), { x: 100, y: 100 });
  assert.deepEqual(clampMenuPosition(780, 590, menu, vp), { x: 594, y: 294 });
  assert.deepEqual(clampMenuPosition(-10, -10, menu, vp), { x: 6, y: 6 });
});

test("opens links only with the platform modifier", () => {
  assert.equal(shouldOpenLink({ metaKey: true, ctrlKey: false }, true), true);
  assert.equal(shouldOpenLink({ metaKey: false, ctrlKey: true }, true), false);
  assert.equal(shouldOpenLink({ metaKey: false, ctrlKey: true }, false), true);
  assert.equal(shouldOpenLink({ metaKey: false, ctrlKey: false }, false), false);
});

test("only http(s) links are openable", () => {
  assert.equal(isOpenableUrl("https://example.com"), true);
  assert.equal(isOpenableUrl("http://localhost:3000/x"), true);
  assert.equal(isOpenableUrl("file:///etc/passwd"), false);
  assert.equal(isOpenableUrl("javascript:alert(1)"), false);
});
