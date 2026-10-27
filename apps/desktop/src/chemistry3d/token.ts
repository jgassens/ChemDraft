import { Plugin3DModelSchema, type Plugin3DModel } from "@chemdraft/plugin-api";

/** One random non-extractable HMAC key per app session, held only by the host, never the workers
 * running plugin code. Coordinates deliberately do not enter the MAC. No model cache is retained. */
export class ModelTokenAuthority {
  private key?: Promise<CryptoKey>;
  private sessionKey(): Promise<CryptoKey> {
    return this.key ??= globalThis.crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  private message(model: Plugin3DModel, seed: number): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify({ atoms: model.atoms, bonds: model.bonds, components: model.components, seed }));
  }
  async sign(model: Plugin3DModel, seed: number): Promise<string> {
    const signature = await globalThis.crypto.subtle.sign("HMAC", await this.sessionKey(), this.message(Plugin3DModelSchema.parse(model), seed));
    return `${seed}.${Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  async verify(input: Plugin3DModel): Promise<{ model: Plugin3DModel; seed: number }> {
    // Parse into a host-owned copy before awaiting: a local plugin cannot race a mutation of the
    // object being verified with the graph ultimately sent to the worker.
    const model = Plugin3DModelSchema.parse(input);
    const match = /^(\d+)\.([0-9a-f]{64})$/.exec(model.modelToken);
    const refused = () => new Error("3D modelToken is invalid for this app session or the atoms, bonds, or components were changed; only coordinates may be edited.");
    if (!match) throw refused();
    const seed = Number(match[1]);
    const signature = Uint8Array.from(match[2].match(/../g)!, pair => Number.parseInt(pair, 16));
    if (!await globalThis.crypto.subtle.verify("HMAC", await this.sessionKey(), signature, this.message(model, seed))) throw refused();
    return { model, seed };
  }
}

export const sessionModelTokens = new ModelTokenAuthority();
