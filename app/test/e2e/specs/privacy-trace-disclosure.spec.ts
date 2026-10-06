import { browser, expect } from '@wdio/globals';

import { waitForApp } from '../helpers/app-helpers';
import { callOpenhumanRpc } from '../helpers/core-rpc';
import { clickText, textExists, waitForTestId, waitForText } from '../helpers/element-helpers';
import { resetApp } from '../helpers/reset-app';
import { navigateViaHash } from '../helpers/shared-flows';
import { startMockServer, stopMockServer } from '../mock-server';

describe('Privacy trace disclosure', () => {
  before(async function () {
    this.timeout(90_000);
    await startMockServer();
    await waitForApp();
    await resetApp('e2e-privacy-trace-disclosure');
    const result = await callOpenhumanRpc('openhuman.config_set_onboarding_completed', {
      value: false,
    });
    if (!result.ok) throw new Error(`Setting onboarding state failed: ${JSON.stringify(result)}`);
    await browser.refresh();
    await waitForApp();
  });

  after(async () => {
    await stopMockServer();
  });

  it('explains separate trace and content opt-ins from the welcome screen', async () => {
    await navigateViaHash('/onboarding/welcome');
    await waitForTestId('onboarding-welcome-step');
    const snapshot = await callOpenhumanRpc<{
      result: {
        config: {
          observability: { share_usage_data: boolean; agent_tracing: { capture_content: boolean } };
        };
      };
    }>('openhuman.config_get');
    if (!snapshot.ok) throw new Error(`Reading consent state failed: ${JSON.stringify(snapshot)}`);
    expect(snapshot.result?.result.config.observability.share_usage_data).toBe(false);
    expect(snapshot.result?.result.config.observability.agent_tracing.capture_content).toBe(false);
    await clickText('What leaves my computer?');
    await waitForText('Agent run traces (opt-in)');
    expect(await textExists('Cloud AI Inference')).toBe(true);
    expect(await textExists('Crash reports and product analytics (opt-out)')).toBe(true);
    expect(
      await textExists(
        'OpenHuman sends timing and token usage data to Langfuse through its backend.'
      )
    ).toBe(true);
    expect(await textExists('prompts, replies, system prompts, and tool inputs and results')).toBe(
      true
    );
    expect(await textExists('Sharing and content capture both start turned off.')).toBe(true);
    await browser.keys('Escape');
    await browser.waitUntil(async () => !(await textExists('Agent run traces (opt-in)')));
    await waitForTestId('onboarding-welcome-step');
  });
});
