import type { GameStore, StoredConnection, StoredGame, StoredProfile } from './types';
import { VersionConflict } from './types';

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory store with the same conditional-write semantics as DynamoDB. Every
 * operation yields to the event loop first, so concurrent requests interleave the way
 * they would against a real database (which is what the concurrency tests rely on).
 */
export class MemoryStore implements GameStore {
  private games = new Map<string, StoredGame>();
  private connections = new Map<string, StoredConnection>();
  private profiles = new Map<string, StoredProfile>();

  private tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  private expired = (expiresAt: number) => expiresAt * 1000 < Date.now();

  async createGame(game: StoredGame) {
    await this.tick();
    const existing = this.games.get(game.code);
    if (existing && !this.expired(existing.expiresAt)) throw new VersionConflict();
    this.games.set(game.code, clone(game));
  }
  async getGame(code: string) {
    await this.tick();
    const game = this.games.get(code);
    if (!game) return null;
    if (this.expired(game.expiresAt)) {
      this.games.delete(code);
      return null;
    }
    return clone(game);
  }
  async saveGame(game: StoredGame, expectedVersion: number) {
    await this.tick();
    if (this.games.get(game.code)?.version !== expectedVersion) throw new VersionConflict();
    this.games.set(game.code, clone(game));
  }

  async putConnection(conn: StoredConnection) {
    await this.tick();
    this.connections.set(conn.connectionId, clone(conn));
  }
  async getConnection(connectionId: string) {
    await this.tick();
    return clone(this.connections.get(connectionId) ?? null);
  }
  async deleteConnection(connectionId: string) {
    await this.tick();
    this.connections.delete(connectionId);
  }
  async listConnections(code: string) {
    await this.tick();
    return [...this.connections.values()].filter((c) => c.code === code).map(clone);
  }

  async getProfile(deviceId: string) {
    await this.tick();
    return clone(this.profiles.get(deviceId) ?? null);
  }
  async saveProfile(profile: StoredProfile, expectedVersion: number) {
    await this.tick();
    if ((this.profiles.get(profile.deviceId)?.version ?? 0) !== expectedVersion) throw new VersionConflict();
    this.profiles.set(profile.deviceId, clone(profile));
  }
}
