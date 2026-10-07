import { expect, test } from '@playwright/test';

import { webElements } from '../../e2e/helpers/element-helpers';
import {
  captureState,
  createNewThread,
  installFakeCapture,
  mockDictationRpc,
  openChat,
  waitForSocketConnected,
} from '../helpers/dictation';

test.describe('Chat composer inline dictation', () => {
  test('keeps the draft editable, inserts one final transcript, and waits for Send', async ({
    page,
  }) => {
    await installFakeCapture(page);
    const { sttCalls, sentMessages } = await mockDictationRpc(page);
    const input = await openChat(page, 'pw-composer-dictation-edit');
    await input.replaceComposerText('Typed first');

    await webElements(page).button('Dictate').click();
    await expect.poll(() => webElements(page).button('Finish dictation').isVisible()).toBe(true);
    await expect.poll(() => input.isEditable()).toBe(true);
    await input.click();
    await input.press('End');
    await input.type(' and edited while speaking');
    await expect.poll(() => input.composerText()).toBe('Typed first and edited while speaking');
    expect(sentMessages).toEqual([]);

    await webElements(page).button('Finish dictation').click();
    const draft = 'Typed first and edited while speaking dictated final words';
    await expect.poll(() => input.composerText()).toBe(draft);
    expect(sttCalls).toHaveLength(1);
    expect(sttCalls[0].params.audio_base64).toBeTruthy();
    expect(sttCalls[0].params.mime_type).toBe('audio/webm');
    expect(sttCalls[0].params).not.toHaveProperty('provider');
    expect(sentMessages).toEqual([]);
    await expect.poll(async () => (await captureState(page)).tracksStopped).toBe(1);

    await input.click();
    await input.press('End');
    await input.type(' — reviewed');
    await waitForSocketConnected(page);
    await expect
      .poll(() => webElements(page).byTestId('send-message-button').isEnabled())
      .toBe(true);
    await webElements(page).byTestId('send-message-button').click();
    await expect.poll(() => sentMessages).toEqual([`${draft} — reviewed`]);
  });

  for (const cancellation of ['Discard dictation', 'Escape'] as const) {
    test(`${cancellation} preserves typed text and ignores a pending STT result`, async ({
      page,
    }) => {
      await installFakeCapture(page);
      const rpc = await mockDictationRpc(page, { holdTranscript: true });
      const input = await openChat(page, `pw-composer-dictation-${cancellation.split(' ')[0]}`);
      await input.replaceComposerText('Keep this draft');
      await webElements(page).button('Dictate').click();
      await expect.poll(() => webElements(page).button('Finish dictation').isVisible()).toBe(true);
      await webElements(page).button('Finish dictation').click();
      await expect.poll(() => rpc.sttCalls.length).toBe(1);

      if (cancellation === 'Escape') {
        await input.click();
        await input.press('Escape');
      } else {
        await webElements(page).button(cancellation).click();
      }
      await expect.poll(() => webElements(page).button('Dictate').isVisible()).toBe(true);
      await input.click();
      await input.press('End');
      await input.type(' and keep editing');
      await rpc.releaseTranscript('late transcript that must be ignored');
      await input.type(' after cancellation');

      await expect
        .poll(() => input.composerText())
        .toBe('Keep this draft and keep editing after cancellation');
      await expect.poll(() => webElements(page).button('Finish dictation').count()).toBe(0);
      expect(rpc.sentMessages).toEqual([]);
      await expect.poll(async () => (await captureState(page)).tracksStopped).toBe(1);
    });
  }

  test('switching threads ignores the previous composer’s pending transcript', async ({ page }) => {
    await installFakeCapture(page);
    const rpc = await mockDictationRpc(page, { holdTranscript: true });
    await openChat(page, 'pw-composer-dictation-thread-switch');
    const input = webElements(page).byTestId('chat-message-input');
    await input.replaceComposerText('First thread draft');
    await webElements(page).button('Dictate').click();
    await expect.poll(() => webElements(page).button('Finish dictation').isVisible()).toBe(true);
    await webElements(page).button('Finish dictation').click();
    await expect.poll(() => rpc.sttCalls.length).toBe(1);

    await createNewThread(page);
    await expect.poll(() => webElements(page).button('Dictate').isVisible()).toBe(true);
    await input.replaceComposerText('Second thread draft');
    await rpc.releaseTranscript('late words from the first thread');
    await input.type(' checked');

    await expect.poll(() => input.composerText()).toBe('Second thread draft checked');
    expect(rpc.sentMessages).toEqual([]);
    await expect.poll(async () => (await captureState(page)).tracksStopped).toBe(1);
  });

  for (const capability of ['missing', 'unavailable'] as const) {
    test(`hides Dictate when the core voice capability is ${capability}`, async ({ page }) => {
      await installFakeCapture(page);
      const rpc = await mockDictationRpc(page, { capability });
      const input = await openChat(page, `pw-composer-dictation-${capability}`);
      await expect.poll(() => rpc.voiceStatusCalls.length).toBeGreaterThan(0);
      await input.replaceComposerText('Typing remains available');

      await expect.poll(() => webElements(page).button('Dictate').count()).toBe(0);
      await expect.poll(() => input.isEditable()).toBe(true);
      expect((await captureState(page)).permissionRequests).toBe(0);
    });
  }

  test('hides Dictate when browser recording is unsupported', async ({ page }) => {
    await installFakeCapture(page, { unsupported: true });
    await mockDictationRpc(page);
    const input = await openChat(page, 'pw-composer-dictation-unsupported');

    await expect.poll(() => webElements(page).button('Dictate').count()).toBe(0);
    await expect.poll(() => input.isEditable()).toBe(true);
    expect((await captureState(page)).permissionRequests).toBe(0);
  });

  test('explains unavailable speech and recovers on focus without switching threads', async ({
    page,
  }) => {
    await installFakeCapture(page);
    const rpc = await mockDictationRpc(page, { capability: 'unavailable' });
    const input = await openChat(page, 'pw-composer-dictation-recovery');
    await input.replaceComposerText('Keep my draft');
    const error = webElements(page).alert('Dictation is unavailable');
    await expect.poll(() => error.isVisible()).toBe(true);
    await expect.poll(() => webElements(page).button('Dictate').count()).toBe(0);
    const threadUrl = page.url();

    rpc.setCapability('available');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => webElements(page).button('Dictate').isVisible()).toBe(true);
    await expect.poll(() => error.count()).toBe(0);
    expect(page.url()).toBe(threadUrl);
    expect(await input.composerText()).toBe('Keep my draft');
    expect((await captureState(page)).permissionRequests).toBe(0);
  });

  test('permission denial shows an actionable error and keeps the draft', async ({ page }) => {
    await installFakeCapture(page, { permissionDenied: true });
    const { sttCalls, sentMessages } = await mockDictationRpc(page);
    const input = await openChat(page, 'pw-composer-dictation-permission');
    await input.replaceComposerText('My draft stays');
    await webElements(page).button('Dictate').click();

    const error = webElements(page).alert('Microphone permission denied');
    await expect.poll(() => error.isVisible()).toBe(true);
    await expect.poll(() => error.text()).toMatch(/permission|denied|microphone/i);
    await expect.poll(() => webElements(page).button('Dictate').isEnabled()).toBe(true);
    await expect.poll(() => input.isEditable()).toBe(true);
    expect(await input.composerText()).toBe('My draft stays');
    expect(sttCalls).toEqual([]);
    expect(sentMessages).toEqual([]);
    expect((await captureState(page)).recordingsStarted).toBe(0);
  });
});
