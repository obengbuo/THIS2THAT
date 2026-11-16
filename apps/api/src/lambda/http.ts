import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleHttp } from '../http';
import { getService } from './shared';

/** HTTP API (payload v2) entry point. CORS is configured on the API itself. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body ?? null;
  const res = await handleHttp(getService(), {
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: event.headers,
    body,
  });
  return {
    statusCode: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(res.body),
  };
}
