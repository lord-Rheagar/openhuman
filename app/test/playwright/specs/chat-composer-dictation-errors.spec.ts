import { expect, test } from '@playwright/test';

import { webElements } from '../../e2e/helpers/element-helpers';
import {
  type CaptureFailure,
  captureState,
  createNewThread,
  installFakeCapture,
  mockDictationRpc,
  openChat,
  setCaptureFailure,
} from '../helpers/dictation';

type FailureCase = {
  capture?: CaptureFailure;
  stt?: 'error' | 'empty';
  alert: string;
  finish?: boolean;
  timeout?: boolean;
  releasedTracks: number;
  sttCalls: number;
};

const recoverableErrors = {
  'microphone-unavailable': {
    capture: 'AbortError',
    alert: 'Microphone is not available',
    releasedTracks: 0,
    sttCalls: 0,
  },
  'permission-denied': {
    capture: 'NotAllowedError',
    alert: 'Microphone permission denied',
    releasedTracks: 0,
    sttCalls: 0,
  },
  'device-unavailable': {
    capture: 'NotFoundError',
    alert: 'Selected microphone is unavailable',
    releasedTracks: 0,
    sttCalls: 0,
  },
  'device-in-use': {
    capture: 'NotReadableError',
    alert: 'Microphone is in use',
    releasedTracks: 0,
    sttCalls: 0,
  },
  'recorder-failed': {
    capture: 'recorder',
    alert: 'Failed to start recorder',
    releasedTracks: 1,
    sttCalls: 0,
  },
  'no-audio': {
    capture: 'empty',
    alert: 'No audio captured',
    finish: true,
    releasedTracks: 1,
    sttCalls: 0,
  },
  'no-speech': {
    stt: 'empty',
    alert: 'No speech detected',
    finish: true,
    releasedTracks: 1,
    sttCalls: 1,
  },
  'transcription-failed': {
    stt: 'error',
    alert: 'Transcription failed',
    finish: true,
    releasedTracks: 1,
    sttCalls: 2,
  },
  'timed-out': { alert: 'Dictation timed out', timeout: true, releasedTracks: 1, sttCalls: 0 },
} satisfies Record<string, FailureCase>;

test.describe('Chat composer dictation errors and fallback', () => {
  for (const [code, failure] of Object.entries<FailureCase>(recoverableErrors)) {
    test(`${code} releases capture, preserves the draft, and allows a successful retry`, async ({
      page,
    }) => {
      await installFakeCapture(page, { failure: failure.capture });
      const rpc = await mockDictationRpc(page, { sttResult: failure.stt });
      const input = await openChat(page, `pw-dictation-error-${code}`);
      await input.replaceComposerText('Keep this draft');
      if (failure.timeout) await page.clock.install();
      await webElements(page).button('Dictate').click();
      if (failure.finish || failure.timeout) {
        await expect
          .poll(() => webElements(page).button('Finish dictation').isVisible())
          .toBe(true);
      }
      if (failure.finish) await webElements(page).button('Finish dictation').click();
      if (failure.timeout) await page.clock.fastForward(60_001);

      const alert = webElements(page).alert(failure.alert);
      await expect.poll(() => alert.isVisible()).toBe(true);
      expect(await alert.text()).not.toContain('Private');
      expect(await input.composerText()).toBe('Keep this draft');
      expect(await input.isEditable()).toBe(true);
      await expect.poll(() => webElements(page).button('Dictate').isEnabled()).toBe(true);
      expect(await webElements(page).button('Discard dictation').count()).toBe(0);
      expect((await captureState(page)).tracksStopped).toBe(failure.releasedTracks);
      expect(rpc.sttCalls).toHaveLength(failure.sttCalls);
      expect(rpc.sentMessages).toEqual([]);

      await setCaptureFailure(page);
      rpc.setSttResult('success');
      await input.click();
      await input.press('End');
      await input.type(' and edited');
      await webElements(page).button('Dictate').click();
      await expect.poll(() => webElements(page).button('Finish dictation').isVisible()).toBe(true);
      await expect.poll(() => alert.count()).toBe(0);
      await webElements(page).button('Finish dictation').click();
      await expect
        .poll(() => input.composerText())
        .toBe('Keep this draft and edited dictated final words');
      await expect.poll(() => webElements(page).button('Dictate').isEnabled()).toBe(true);
      expect((await captureState(page)).tracksStopped).toBe(failure.releasedTracks + 1);
      expect(rpc.sttCalls).toHaveLength(failure.sttCalls + 1);
      expect(rpc.sentMessages).toEqual([]);
    });
  }

  test('a failed voice-status RPC explains availability and recovers in the same composer', async ({
    page,
  }) => {
    await installFakeCapture(page);
    const rpc = await mockDictationRpc(page, { capability: 'error' });
    const input = await openChat(page, 'pw-dictation-status-error');
    await input.replaceComposerText('Keep this draft');
    const alert = webElements(page).alert('Could not check dictation availability');
    await expect.poll(() => alert.isVisible()).toBe(true);
    expect(await alert.text()).not.toContain('Private');
    expect(await webElements(page).button('Dictate').count()).toBe(0);
    expect(await input.isEditable()).toBe(true);
    expect((await captureState(page)).permissionRequests).toBe(0);
    expect(rpc.sttCalls).toEqual([]);
    const threadUrl = page.url();

    rpc.setCapability('available');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => webElements(page).button('Dictate').isEnabled()).toBe(true);
    await expect.poll(() => alert.count()).toBe(0);
    expect(page.url()).toBe(threadUrl);
    expect(await input.composerText()).toBe('Keep this draft');
    await webElements(page).button('Dictate').click();
    await webElements(page).button('Finish dictation').click();
    await expect.poll(() => input.composerText()).toBe('Keep this draft dictated final words');
    expect((await captureState(page)).tracksStopped).toBe(1);
    expect(rpc.sentMessages).toEqual([]);
  });

  test('a missing STT method withdraws dictation, preserves the draft, and rechecks for the next thread', async ({
    page,
  }) => {
    await installFakeCapture(page);
    const rpc = await mockDictationRpc(page, { sttResult: 'missing' });
    const input = await openChat(page, 'pw-dictation-missing-stt');
    await input.replaceComposerText('Keep this draft');
    await webElements(page).button('Dictate').click();
    await webElements(page).button('Finish dictation').click();
    const alert = webElements(page).alert('Voice transcription is not included');
    await expect.poll(() => alert.isVisible()).toBe(true);
    expect(await input.composerText()).toBe('Keep this draft');
    expect(await input.isEditable()).toBe(true);
    expect(await webElements(page).button('Dictate').count()).toBe(0);
    expect(await webElements(page).button('Discard dictation').count()).toBe(0);
    expect((await captureState(page)).tracksStopped).toBe(1);
    expect(rpc.sttCalls).toHaveLength(1);
    expect(rpc.sentMessages).toEqual([]);

    rpc.setSttResult('success');
    await createNewThread(page);
    await input.replaceComposerText('Next thread');
    await webElements(page).button('Dictate').click();
    await expect.poll(() => alert.count()).toBe(0);
    await webElements(page).button('Finish dictation').click();
    await expect.poll(() => input.composerText()).toBe('Next thread dictated final words');
    expect((await captureState(page)).tracksStopped).toBe(2);
    expect(rpc.sentMessages).toEqual([]);
  });

  test('retries rejected native audio as real PCM WAV and appends the final transcript once', async ({
    page,
  }) => {
    await installFakeCapture(page);
    const rpc = await mockDictationRpc(page, { sttResult: 'wav-only' });
    const input = await openChat(page, 'pw-dictation-wav-fallback');
    await input.replaceComposerText('Typed first');
    await webElements(page).button('Dictate').click();
    await webElements(page).button('Finish dictation').click();
    await expect.poll(() => input.composerText()).toBe('Typed first dictated final words');
    await expect.poll(() => webElements(page).button('Dictate').isEnabled()).toBe(true);
    expect(rpc.sttCalls.map(call => call.params.mime_type)).toEqual(['audio/webm', 'audio/wav']);
    const native = Buffer.from(String(rpc.sttCalls[0].params.audio_base64), 'base64');
    expect(native.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); // EBML/WebM header
    const wav = Buffer.from(String(rpc.sttCalls[1].params.audio_base64), 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.subarray(44).some(byte => byte !== 0)).toBe(true);
    expect(rpc.sttCalls[1].params.file_name).toBe('audio.wav');
    expect((await captureState(page)).tracksStopped).toBe(1);
    expect(rpc.sentMessages).toEqual([]);
    // Editing after completion proves the composer is idle and has one result.
    await input.click();
    await input.press('End');
    await input.type(' reviewed');
    expect(await input.composerText()).toBe('Typed first dictated final words reviewed');
    expect(rpc.sttCalls).toHaveLength(2);
  });
});
