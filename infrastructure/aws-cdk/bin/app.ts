#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { FromThisToThatStack } from '../lib/stack';

const app = new App();
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'prod';

new FromThisToThatStack(app, `FromThisToThat-${stage}`, {
  stage,
  // Comma-separated site origins allowed to call the API, e.g. "https://play.example.com".
  allowedOrigins: String(app.node.tryGetContext('allowedOrigins') ?? '*').split(',').map((o) => o.trim()),
  alarmEmail: app.node.tryGetContext('alarmEmail'),
  // Optional Amplify Hosting app connected to GitHub (see README, "Deploying the website").
  githubRepo: app.node.tryGetContext('githubRepo'),
  githubBranch: app.node.tryGetContext('githubBranch') ?? 'main',
  githubTokenSecretName: app.node.tryGetContext('githubTokenSecretName'),
  domainName: app.node.tryGetContext('domainName'),
  // Credentials and region come from the standard AWS environment/profile — never hardcoded.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
