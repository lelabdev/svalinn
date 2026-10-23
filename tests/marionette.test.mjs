import assert from "node:assert/strict";
import test from "node:test";
import {
  MarionetteClient,
  MarionetteError,
  MessageDecoder,
  encodeMessage,
} from "../src/zen/marionette.mjs";

test("encodes length-prefixed frames by UTF-8 byte length", () => {
  const frame = encodeMessage([0, 1, "WebDriver:NewSession", {}]);
  const [header, body] = frame.split(/:(.*)/s);
  assert.equal(Number(header), Buffer.byteLength(body, "utf8"));
  assert.deepEqual(JSON.parse(body), [0, 1, "WebDriver:NewSession", {}]);

  const unicode = encodeMessage({ value: "héllo" });
  assert.equal(
    Number(unicode.slice(0, unicode.indexOf(":"))),
    Buffer.byteLength(unicode.slice(unicode.indexOf(":") + 1), "utf8")
  );
});

test("decodes partial, batched and multibyte frames", () => {
  const decoder = new MessageDecoder({ expectHandshake: false });
  const frame = encodeMessage({ value: "héllo" });

  assert.deepEqual(decoder.push(Buffer.from(frame.slice(0, 2))), []);
  assert.deepEqual(decoder.push(Buffer.from(frame.slice(2, 10))), []);
  assert.deepEqual(decoder.push(Buffer.from(frame.slice(10))), [
    { value: "héllo" },
  ]);

  const batch = encodeMessage({ n: 1 }) + encodeMessage({ n: 2 });
  assert.deepEqual(decoder.push(Buffer.from(batch)), [{ n: 1 }, { n: 2 }]);
});

test("separates the Marionette handshake from protocol messages", () => {
  const decoder = new MessageDecoder();
  const handshake = encodeMessage({
    applicationType: "gecko",
    marionetteProtocol: 3,
  });
  const response = encodeMessage([1, 1, null, { value: true }]);

  assert.deepEqual(decoder.push(Buffer.from(handshake + response)), [
    [1, 1, null, { value: true }],
  ]);
  assert.deepEqual(decoder.handshake, {
    applicationType: "gecko",
    marionetteProtocol: 3,
  });
});

test("rejects malformed frame lengths", () => {
  const decoder = new MessageDecoder({ expectHandshake: false });
  assert.throws(() => decoder.push(Buffer.from("nope:{}")), /Invalid Marionette frame length/);
});

function makeClient() {
  const writes = [];
  const socket = {
    write(frame) {
      writes.push(frame);
    },
    destroy() {},
  };
  const client = new MarionetteClient(socket, new MessageDecoder());
  client._receive(
    Buffer.from(
      encodeMessage({ applicationType: "gecko", marionetteProtocol: 3 })
    )
  );
  return { client, writes, socket };
}

test("resolves commands by id and rejects remote errors", async () => {
  const { client, writes } = makeClient();

  const ok = client.send("WebDriver:GetTitle");
  const [, id] = JSON.parse(writes[0].slice(writes[0].indexOf(":") + 1));
  client._dispatch([1, id, null, { value: "Svalinn" }]);
  assert.deepEqual(await ok, { value: "Svalinn" });

  const failed = client.send("WebDriver:ExecuteScript", { script: "x" });
  const [, failedId] = JSON.parse(
    writes[1].slice(writes[1].indexOf(":") + 1)
  );
  client._dispatch([
    1,
    failedId,
    { error: "javascript error", message: "boom", stacktrace: "at x" },
    null,
  ]);
  await assert.rejects(failed, error => {
    assert.ok(error instanceof MarionetteError);
    assert.equal(error.code, "javascript error");
    assert.equal(error.command, "WebDriver:ExecuteScript");
    assert.equal(error.stacktrace, "at x");
    return true;
  });
});

test("rejects pending commands when the connection closes", async () => {
  const { client } = makeClient();
  const pending = client.send("WebDriver:GetTitle");
  client._rejectAll(new Error("connection closed"));
  await assert.rejects(pending, /connection closed/);
});
