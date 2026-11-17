import path from 'node:path';
import {
  CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps,
  aws_amplify as amplify, aws_apigatewayv2 as apigw, aws_cloudwatch as cloudwatch, aws_cloudwatch_actions as cwActions,
  aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, aws_lambda_nodejs as nodejs, aws_logs as logs,
  aws_sns as sns, aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { Construct } from 'constructs';

export interface FromThisToThatProps extends StackProps {
  stage: string;
  allowedOrigins: string[];
  alarmEmail?: string;
  githubRepo?: string;
  githubBranch?: string;
  githubTokenSecretName?: string;
  domainName?: string;
}

const API_SRC = path.join(__dirname, '..', '..', '..', 'apps', 'api', 'src', 'lambda');

/**
 * Serverless, pay-per-use backend:
 *
 *   Browser ──HTTPS──▶ API Gateway HTTP API ──▶ Lambda (http) ─┐
 *   Browser ◀──WSS──▶ API Gateway WebSocket ──▶ Lambda (ws) ───┼──▶ DynamoDB (single table)
 *                              ▲                               │
 *                              └── PostToConnection (push) ◀───┘
 *
 * Nothing runs (or bills) while nobody is playing.
 */
export class FromThisToThatStack extends Stack {
  constructor(scope: Construct, id: string, props: FromThisToThatProps) {
    super(scope, id, props);
    const isProd = props.stage === 'prod';

    // ── Data ────────────────────────────────────────────────────────────────
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt', // rooms, connections and idle profiles clean themselves up
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ── Compute ─────────────────────────────────────────────────────────────
    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, // cheaper per ms than x86
      memorySize: 512,
      timeout: Duration.seconds(10),
      tracing: lambda.Tracing.DISABLED,
      environment: {
        TABLE_NAME: table.tableName,
        ALLOWED_ORIGINS: props.allowedOrigins.join(','),
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, target: 'node22', format: nodejs.OutputFormat.CJS },
    } satisfies nodejs.NodejsFunctionProps;

    const fn = (name: string, entry: string) =>
      new nodejs.NodejsFunction(this, name, {
        ...common,
        entry: path.join(API_SRC, entry),
        handler: 'handler',
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
    const httpFn = fn('HttpFn', 'http.ts');
    const wsFn = fn('WsFn', 'ws.ts');

    // ── Real-time API ───────────────────────────────────────────────────────
    const wsIntegration = (id: string) => new WebSocketLambdaIntegration(id, wsFn);
    const wsApi = new apigw.WebSocketApi(this, 'WsApi', {
      apiName: `ftt-ws-${props.stage}`,
      connectRouteOptions: { integration: wsIntegration('OnConnect') },
      disconnectRouteOptions: { integration: wsIntegration('OnDisconnect') },
      defaultRouteOptions: { integration: wsIntegration('OnMessage') },
    });
    const wsStage = new apigw.WebSocketStage(this, 'WsStage', {
      webSocketApi: wsApi,
      stageName: props.stage,
      autoDeploy: true,
      throttle: { rateLimit: 100, burstLimit: 200 },
    });

    // Least privilege: only the item-level actions the store uses, on this table only,
    // and only "post to connection" on this WebSocket stage.
    for (const f of [httpFn, wsFn]) {
      f.addEnvironment('WS_CALLBACK_URL', wsStage.callbackUrl); // where pushes to browsers are sent
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
          resources: [table.tableArn],
        }),
      );
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['execute-api:ManageConnections'],
          resources: [this.formatArn({ service: 'execute-api', resource: wsApi.apiId, resourceName: `${wsStage.stageName}/POST/@connections/*` })],
        }),
      );
    }

    // ── HTTP API ────────────────────────────────────────────────────────────
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `ftt-http-${props.stage}`,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type', 'authorization'],
        maxAge: Duration.hours(1),
      },
    });
    // GET and POST only: with no route for OPTIONS, API Gateway answers CORS preflights
    // itself (a catch-all default route would forward them to the Lambda instead).
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('HttpRoutes', httpFn),
    });
    // Request throttling (basic abuse prevention) on the default stage.
    (httpApi.defaultStage!.node.defaultChild as apigw.CfnStage).defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    };

    // ── Monitoring ──────────────────────────────────────────────────────────
    const topic = new sns.Topic(this, 'Alarms', { displayName: `FROM THIS TO THAT alarms (${props.stage})` });
    if (props.alarmEmail) topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string) =>
      new cloudwatch.Alarm(this, id, {
        metric, threshold, evaluationPeriods: 1, alarmDescription: description,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cwActions.SnsAction(topic));
    const five = { period: Duration.minutes(5), statistic: 'Sum' };
    alarm('HttpFnErrors', httpFn.metricErrors(five), 5, 'HTTP Lambda errors');
    alarm('WsFnErrors', wsFn.metricErrors(five), 5, 'WebSocket Lambda errors');
    alarm('HttpFnSlow', httpFn.metricDuration({ period: Duration.minutes(5), statistic: 'p95' }), 3000, 'HTTP Lambda p95 latency above 3s');
    alarm('Http5xx', httpApi.metricServerError(five), 10, 'HTTP API 5xx responses');
    alarm('TableThrottles', table.metricThrottledRequestsForOperations({
      operations: [dynamodb.Operation.PUT_ITEM, dynamodb.Operation.GET_ITEM, dynamodb.Operation.QUERY], ...five,
    }), 1, 'DynamoDB throttled requests');

    // ── Website (optional): Amplify Hosting connected to GitHub ─────────────
    const apiUrl = httpApi.apiEndpoint;
    const wsUrl = wsStage.url;
    if (props.githubRepo && props.githubTokenSecretName) {
      const app = new amplify.CfnApp(this, 'Web', {
        name: `from-this-to-that-${props.stage}`,
        repository: `https://github.com/${props.githubRepo}`,
        // The token is read from AWS Secrets Manager at deploy time — never stored in code.
        accessToken: SecretValue.secretsManager(props.githubTokenSecretName).unsafeUnwrap(),
        platform: 'WEB', // static export: no SSR compute to pay for
        environmentVariables: [
          { name: 'NEXT_PUBLIC_API_URL', value: apiUrl },
          { name: 'NEXT_PUBLIC_WS_URL', value: wsUrl },
          { name: 'AMPLIFY_MONOREPO_APP_ROOT', value: 'apps/web' },
        ],
        customRules: [{ source: '/<*>', target: '/index.html', status: '404-200' }],
      });
      const branch = new amplify.CfnBranch(this, 'WebBranch', {
        appId: app.attrAppId, branchName: props.githubBranch ?? 'main', enableAutoBuild: true, stage: 'PRODUCTION',
      });
      if (props.domainName) {
        // Amplify provisions and renews the ACM certificate and, for Route 53 hosted
        // zones in this account, creates the DNS records.
        new amplify.CfnDomain(this, 'WebDomain', {
          appId: app.attrAppId, domainName: props.domainName,
          subDomainSettings: [{ branchName: branch.branchName, prefix: '' }, { branchName: branch.branchName, prefix: 'www' }],
        }).node.addDependency(branch);
      }
      new CfnOutput(this, 'WebsiteUrl', { value: `https://${branch.branchName}.${app.attrDefaultDomain}` });
    }

    new CfnOutput(this, 'ApiUrl', { value: apiUrl, description: 'Set as NEXT_PUBLIC_API_URL' });
    new CfnOutput(this, 'WebSocketUrl', { value: wsUrl, description: 'Set as NEXT_PUBLIC_WS_URL' });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'AlarmTopicArn', { value: topic.topicArn });
  }
}
