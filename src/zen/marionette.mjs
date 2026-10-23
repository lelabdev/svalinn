/**
 * Minimal client for the Marionette protocol (protocol version 3).
 *
 * Marionette is built into Gecko and is only enabled for the explicit smoke
 * session. Messages are length-prefixed JSON frames: `<byteLength>:<json>`.
 */

import net from "node:net";

const DEFAULT_SANDBOX = "svalinn";

export class MarionetteError extends Error {
  constructor(remoteError, command) {
    super(remoteError?.message ?? "Marionette command failed");
    this.name = "MarionetteError";
    this.code = remoteError?.error ?? "unknown error";
    this.stacktrace = remoteError?.stacktrace ?? null;
    this.command = command;
  }
}

/**
 * Incremental decoder for Marionette frames.
 */
export class MessageDecoder {
  constructor({ expectHandshake = true } = {}) {
    this.buffer = Buffer.alloc(0);
    this.expectHandshake = expectHandshake;
    this.handshake = null;
  }

  /**
   * @param {Buffer} chunk
   * @returns {Array<unknown>} Complete protocol messages (handshake excluded).
   */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    for (;;) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon === -1) break;
      const header = this.buffer.subarray(0, colon).toString("utf8");
      if (!/^\d+$/.test(header)) {
        throw new Error(`Invalid Marionette frame length: ${header}`);
      }
      const length = Number(header);
      if (this.buffer.length < colon + 1 + length) break;
      const raw = this.buffer
        .subarray(colon + 1, colon + 1 + length)
        .toString("utf8");
      this.buffer = this.buffer.subarray(colon + 1 + length);
      const message = JSON.parse(raw);
      if (this.expectHandshake && !this.handshake) {
        this.handshake = message;
        continue;
      }
      messages.push(message);
    }
    return messages;
  }
}

/**
 * @param {unknown} message
 * @returns {string}
 */
export function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `${Buffer.byteLength(body)}:${body}`;
}

export class MarionetteClient {
  /**
   * @param {import("node:net").Socket} socket
   * @param {MessageDecoder} decoder
   */
  constructor(socket, decoder) {
    this.socket = socket;
    this.decoder = decoder;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.handshake = null;
    this._handshakePromise = new Promise((resolve, reject) => {
      this._resolveHandshake = resolve;
      this._rejectHandshake = reject;
    });
    this._handshakeSettled = false;
  }

  /**
   * Connect to an already running Zen/Marionette server, retrying until the
   * deadline. Attach socket handlers before waiting for `connect` so the
   * handshake frame cannot be missed.
   *
   * @param {object} [options]
   * @returns {Promise<MarionetteClient>}
   */
  static connect({
    host = "127.0.0.1",
    port = 2828,
    retryTimeoutMs = 30_000,
    retryDelayMs = 250,
  } = {}) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + retryTimeoutMs;

      const attempt = () => {
        const socket = net.createConnection({ host, port });
        const decoder = new MessageDecoder();
        const client = new MarionetteClient(socket, decoder);
        let settled = false;

        const retryOrFail = error => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (Date.now() >= deadline) {
            reject(error);
            return;
          }
          setTimeout(attempt, retryDelayMs);
        };

        socket.on("data", chunk => {
          try {
            client._receive(chunk);
          } catch (error) {
            client._rejectAll(error);
            socket.destroy();
          }
        });
        socket.once("error", retryOrFail);
        socket.once("close", () => {
          if (!settled) {
            retryOrFail(new Error("Marionette connection closed before handshake"));
          } else {
            client._rejectAll(new Error("Marionette connection closed"));
          }
        });

        client._handshakePromise.then(
          () => {
            if (settled) return;
            settled = true;
            socket.removeListener("error", retryOrFail);
            socket.on("error", error => client._rejectAll(error));
            resolve(client);
          },
          error => retryOrFail(error)
        );
      };

      attempt();
    });
  }

  _receive(chunk) {
    const messages = this.decoder.push(chunk);
    if (this.decoder.handshake && !this._handshakeSettled) {
      this._handshakeSettled = true;
      this.handshake = this.decoder.handshake;
      if (this.handshake?.applicationType !== "gecko") {
        this._rejectHandshake(
          new Error(
            `Unexpected Marionette handshake: ${JSON.stringify(this.handshake)}`
          )
        );
      } else {
        this._resolveHandshake(this.handshake);
      }
    }
    for (const message of messages) this._dispatch(message);
  }

  _dispatch(message) {
    if (!Array.isArray(message) || message.length < 4) return;
    const [, id, error, result] = message;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) {
      pending.reject(new MarionetteError(error, pending.command));
    } else {
      pending.resolve(result);
    }
  }

  _rejectAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this._handshakeSettled) {
      this._handshakeSettled = true;
      this._rejectHandshake(error);
    }
  }

  /**
   * @param {string} command
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  send(command, params = {}, timeoutMs = 30_000) {
    if (this.closed) {
      return Promise.reject(new Error("Marionette connection is closed"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette command timed out: ${command}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, command });
      this.socket.write(encodeMessage([0, id, command, params]));
    });
  }

  async newSession(capabilities = { alwaysMatch: {} }) {
    return this.send("WebDriver:NewSession", { capabilities });
  }

  async setContext(context) {
    return this.send("Marionette:SetContext", { value: context });
  }

  /**
   * @param {string} script
   * @param {object} [options]
   */
  async execute(
    script,
    {
      args = [],
      async = false,
      sandbox = DEFAULT_SANDBOX,
      newSandbox = false,
      timeoutMs = 60_000,
    } = {}
  ) {
    const command = async
      ? "WebDriver:ExecuteAsyncScript"
      : "WebDriver:ExecuteScript";
    return this.send(
      command,
      { script, args, sandbox, newSandbox },
      timeoutMs
    );
  }

  async quit({ flags = ["eForceQuit"], timeoutMs = 15_000 } = {}) {
    try {
      return await this.send("Marionette:Quit", { flags }, timeoutMs);
    } catch (error) {
      // The browser may close the socket before acknowledging the quit.
      if (this.closed || /connection closed/i.test(String(error))) return null;
      throw error;
    }
  }

  close() {
    this.closed = true;
    this.socket.destroy();
    this._rejectAll(new Error("Marionette client closed"));
  }
}
