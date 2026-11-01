import { Plugin3DModelSchema, type Plugin3DModel } from "@chemdraft/plugin-api";
import { timeHost3d, timeHost3dAsync } from "./hostTiming";
import type { Chemistry3dTimingSink } from "./timing";

/** One random non-extractable HMAC key per app session, held only by the host, never the workers
 * running plugin code. Coordinates deliberately do not enter the MAC. No model cache is retained. */
export class ModelTokenAuthority {
  private key?: Promise<CryptoKey>;
  constructor(private readonly onTiming?: Chemistry3dTimingSink) {}
  private sessionKey(): Promise<CryptoKey> {
    return this.key ??= globalThis.crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  private message(model: Plugin3DModel, seed: number): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify({ atoms: model.atoms, bonds: model.bonds, components: model.components, seed }));
  }
  async sign(model: Plugin3DModel, seed: number): Promise<string> {
    const key = await timeHost3dAsync(this.onTiming, "token.sign.key-wait", () => this.sessionKey());
    const parsed = timeHost3d(this.onTiming, "token.sign.model-schema", () => Plugin3DModelSchema.parse(model));
    const message = timeHost3d(this.onTiming, "token.sign.encode", () => this.message(parsed, seed));
    const signature = await timeHost3dAsync(this.onTiming, "token.sign.webcrypto", () =>
      globalThis.crypto.subtle.sign("HMAC", key, message));
    return timeHost3d(this.onTiming, "token.sign.serialize", () =>
      `${seed}.${Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("")}`);
  }
  async verify(input: Plugin3DModel): Promise<{ model: Plugin3DModel; seed: number }> {
    // Parse into a host-owned copy before awaiting: a local plugin cannot race a mutation of the
    // object being verified with the graph ultimately sent to the worker.
    const model = timeHost3d(this.onTiming, "token.verify.model-schema", () => Plugin3DModelSchema.parse(input));
    const match = /^(\d+)\.([0-9a-f]{64})$/.exec(model.modelToken);
    const refused = () => new Error("3D modelToken is invalid for this app session or the atoms, bonds, or components were changed; only coordinates may be edited.");
    if (!match) throw refused();
    const seed = Number(match[1]);
    const signature = Uint8Array.from(match[2].match(/../g)!, pair => Number.parseInt(pair, 16));
    const key = await timeHost3dAsync(this.onTiming, "token.verify.key-wait", () => this.sessionKey());
    const message = timeHost3d(this.onTiming, "token.verify.encode", () => this.message(model, seed));
    if (!await timeHost3dAsync(this.onTiming, "token.verify.webcrypto", () =>
      globalThis.crypto.subtle.verify("HMAC", key, signature, message))) throw refused();
    return { model, seed };
  }
}

export const sessionModelTokens = new ModelTokenAuthority();
