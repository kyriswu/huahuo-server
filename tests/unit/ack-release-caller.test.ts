import { describe, expect, it } from 'vitest';
// @ts-expect-error The protected runner is plain JavaScript.
import { releaseAckImage } from '../../deploy/k8s/invoke-ack-release.mjs';

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const instanceId = 'i-2zeaydxol26pp3dxg1ak';
const commandId = 'c-testcommand';
const invokeId = 't-testinvoke';
const env = {
  TEST_ACK_BUILDER_INSTANCE_ID: instanceId,
  TEST_ACK_RELEASE_COMMAND_ID: commandId,
  TEST_RELEASE_SHA: sha,
  ALIBABA_CLOUD_ACCESS_KEY_ID: 'STS.test-only',
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'fixture',
  ALIBABA_CLOUD_SECURITY_TOKEN: 'fixture',
};

function cloudResponse(status: 'passed' | 'deployed') {
  return {
    call: async (action: string) => action === 'InvokeCommand' ? { InvokeId: invokeId } : {
      Invocation: { InvocationResults: { InvocationResult: [{
        InstanceId: instanceId,
        CommandId: commandId,
        InvokeId: invokeId,
        InvocationStatus: 'Success',
        ExitCode: 0,
        Output: JSON.stringify({ version: 1, sha, status, digest }),
      }] } },
    },
  };
}

describe('ACK deployment result', () => {
  it('accepts the rollout receipt for the selected SHA and digest', async () => {
    await expect(releaseAckImage(env, cloudResponse('deployed'))).resolves.toEqual({ sha, digest });
  });

  it('rejects a verification-only receipt as evidence of deployment', async () => {
    await expect(releaseAckImage(env, cloudResponse('passed'))).rejects.toThrow('TEST_ACK_OUTPUT_INVALID');
  });
});
