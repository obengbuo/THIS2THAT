import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { GameService, type Broadcaster } from '../service';
import { DynamoStore } from '../store/dynamo';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Pushes to browsers through the API Gateway WebSocket management endpoint. */
class ApiGatewayBroadcaster implements Broadcaster {
  private client = new ApiGatewayManagementApiClient({ endpoint: required('WS_CALLBACK_URL') });
  async send(connectionId: string, payload: string): Promise<boolean> {
    try {
      await this.client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: payload }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 410) return false; // GoneException: the browser disconnected
      console.warn(JSON.stringify({ event: 'broadcast_error', connectionId, error: String(err) }));
      return true;
    }
  }
}

let service: GameService | undefined;

/** One service per Lambda container (reuses SDK clients and the in-memory word graph). */
export function getService(): GameService {
  service ??= new GameService(new DynamoStore(required('TABLE_NAME')), new ApiGatewayBroadcaster(), {
    logger: (event, data) => console.log(JSON.stringify({ event, ...data })),
  });
  return service;
}
