import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { GameStore, StoredConnection, StoredGame, StoredProfile } from './types';
import { VersionConflict } from './types';

/**
 * Single-table DynamoDB layout (PK / SK):
 *
 *   GAME#<code>        / STATE            game session, incl. locked words  (ttl)
 *   GAME#<code>        / CONN#<connId>    live WebSocket connection         (ttl)
 *   CONN#<connId>      / META             reverse lookup for $disconnect    (ttl)
 *   PLAYER#<deviceId>  / PROFILE          statistics + recent puzzle history (ttl)
 *
 * Word locking is atomic: saveGame is a conditional Put on the `version` attribute.
 */
export class DynamoStore implements GameStore {
  private doc: DynamoDBDocumentClient;

  constructor(private table: string, client = new DynamoDBClient({})) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  private async conditional<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (err instanceof ConditionalCheckFailedException || name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException')
        throw new VersionConflict();
      throw err;
    }
  }

  private async get<T>(pk: string, sk: string): Promise<T | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }));
    if (!res.Item) return null;
    // TTL deletion is lazy, so treat expired items as gone.
    if (typeof res.Item.expiresAt === 'number' && res.Item.expiresAt * 1000 < Date.now()) return null;
    return res.Item.data as T;
  }

  async createGame(game: StoredGame) {
    await this.conditional(() =>
      this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `GAME#${game.code}`, sk: 'STATE', version: game.version, expiresAt: game.expiresAt, data: game },
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
        }),
      ),
    );
  }
  getGame(code: string) {
    return this.get<StoredGame>(`GAME#${code}`, 'STATE');
  }
  async saveGame(game: StoredGame, expectedVersion: number) {
    await this.conditional(() =>
      this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `GAME#${game.code}`, sk: 'STATE', version: game.version, expiresAt: game.expiresAt, data: game },
          ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': expectedVersion },
        }),
      ),
    );
  }

  async putConnection(conn: StoredConnection) {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: { pk: `GAME#${conn.code}`, sk: `CONN#${conn.connectionId}`, expiresAt: conn.expiresAt, data: conn } } },
          { Put: { TableName: this.table, Item: { pk: `CONN#${conn.connectionId}`, sk: 'META', expiresAt: conn.expiresAt, data: conn } } },
        ],
      }),
    );
  }
  getConnection(connectionId: string) {
    return this.get<StoredConnection>(`CONN#${connectionId}`, 'META');
  }
  async deleteConnection(connectionId: string, code: string) {
    await Promise.all([
      this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: `GAME#${code}`, sk: `CONN#${connectionId}` } })),
      this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: `CONN#${connectionId}`, sk: 'META' } })),
    ]);
  }
  async listConnections(code: string) {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `GAME#${code}`, ':prefix': 'CONN#' },
        ConsistentRead: true,
      }),
    );
    const now = Date.now();
    return (res.Items ?? []).filter((i) => i.expiresAt * 1000 > now).map((i) => i.data as StoredConnection);
  }

  getProfile(deviceId: string) {
    return this.get<StoredProfile>(`PLAYER#${deviceId}`, 'PROFILE');
  }
  async saveProfile(profile: StoredProfile, expectedVersion: number) {
    await this.conditional(() =>
      this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `PLAYER#${profile.deviceId}`, sk: 'PROFILE', version: profile.version, expiresAt: profile.expiresAt, data: profile },
          ...(expectedVersion === 0
            ? {
                ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
                ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
              }
            : {
                ConditionExpression: '#v = :expected',
                ExpressionAttributeNames: { '#v': 'version' },
                ExpressionAttributeValues: { ':expected': expectedVersion },
              }),
        }),
      ),
    );
  }
}
