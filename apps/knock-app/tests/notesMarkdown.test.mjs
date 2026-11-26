import test from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, highlightCode } from "../.test-dist/src/notesMarkdown.js";

test("fenced code is highlighted by language and gets a copy button", () => {
  const html = markdownToHtml("```js\nconst a = 1;\n```");
  assert.match(html, /class="hljs language-js"/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /data-code-action="copy"/);
  assert.match(markdownToHtml("```sh\necho hi | grep h\n```"), /hljs-built_in|hljs-keyword/);
});

test("unknown or missing language is escaped plain text", () => {
  const html = markdownToHtml("```nope\n<script>x</script>\n```");
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(highlightCode("a<b", ""), "a&lt;b");
});

test("language label cannot inject markup", () => {
  const html = markdownToHtml('```js"><img src=x onerror=alert(1)>\nx\n```');
  assert.doesNotMatch(html, /<img/);
});

test("inline ||secret|| renders masked with the escaped value hidden", () => {
  const html = markdownToHtml("key: ||sk-<live>-123|| ok");
  assert.match(html, /class="note-secret"/);
  assert.match(html, /note-secret-mask">••••••••</);
  assert.match(html, /note-secret-value">sk-&lt;live&gt;-123</);
  assert.match(html, /data-secret-action="copy"/);
  assert.match(html, / ok/);
});

test("secret syntax is literal inside code spans and needs closing pipes", () => {
  assert.doesNotMatch(markdownToHtml("`a ||b|| c`"), /note-secret/);
  assert.doesNotMatch(markdownToHtml("a || b"), /note-secret/);
});

test("```secret blocks are masked and keep their lines", () => {
  const html = markdownToHtml("```secret\nUSER=a\nPASS=<b>\n```");
  assert.match(html, /note-secret note-secret-block/);
  assert.match(html, /2 lines/);
  assert.match(html, /PASS=&lt;b&gt;/);
  assert.doesNotMatch(html, /class="hljs/);
});
