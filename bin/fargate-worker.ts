#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FargateWorkerStack } from '../lib/fargate-worker-stack';

const app = new cdk.App();
new FargateWorkerStack(app, 'FargateWorkerStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
