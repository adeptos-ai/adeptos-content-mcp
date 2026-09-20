import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIRM_PREVIEW_MESSAGE, redactDeep, redactString, requireConfirm } from "../src/safety.js";

describe("requireConfirm", () => {
  it("previews without confirm", () => {
    const gate = requireConfirm({});
    assert.equal(gate.mode, "preview");
    if (gate.mode === "preview") assert.match(gate.message, /confirm:true/);
    assert.match(CONFIRM_PREVIEW_MESSAGE, /Ryan/);
  });

  it("executes when confirm is true", () => {
    const gate = requireConfirm({ confirm: true });
    assert.deepEqual(gate, { mode: "execute", dryRun: false });
  });

  it("honors dryRun with confirm", () => {
    const gate = requireConfirm({ confirm: true, dryRun: true });
    assert.deepEqual(gate, { mode: "execute", dryRun: true });
  });
});

describe("redact", () => {
  it("strips Meta, TikTok, Google, and query tokens", () => {
    const raw =
      "url=https://graph.facebook.com/x?access_token=EAABSECRET123&refresh_token=1//abcDEF " +
      "Bearer ya29.xyz Authorization act.tiktoksecret EAAZZZ999";
    const out = redactString(raw);
    assert.equal(out.includes("EAABSECRET123"), false);
    assert.equal(out.includes("act.tiktoksecret"), false);
    assert.equal(out.includes("ya29.xyz"), false);
    assert.match(out, /REDACTED/);
  });

  it("redacts secret keys in objects", () => {
    const out = redactDeep({
      access_token: "EAABHIDE",
      nested: { client_secret: "shh", ok: 1 },
    }) as { access_token: string; nested: { client_secret: string; ok: number } };
    assert.equal(out.access_token, "[REDACTED]");
    assert.equal(out.nested.client_secret, "[REDACTED]");
    assert.equal(out.nested.ok, 1);
  });
});
