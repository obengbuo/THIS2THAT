import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { ApiError } from '../errors';
import { getService } from './shared';

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string | undefined> };

/** WebSocket API entry point for $connect, $disconnect and $default. */
export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const { routeKey, connectionId } = event.requestContext;
  const service = getService();
  try {
    if (routeKey === '$connect') await service.connect(connectionId, event.queryStringParameters ?? {});
    else if (routeKey === '$disconnect') await service.disconnect(connectionId);
    else await service.message(connectionId, event.body ?? '');
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    if (err instanceof ApiError) return { statusCode: err.status, body: err.code };
    console.error('ws_error', err);
    return { statusCode: 500, body: 'error' };
  }
}
