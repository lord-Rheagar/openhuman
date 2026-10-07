import { expect, type Page, test } from '@playwright/test';

import { webElements, type WebTestElement } from '../../e2e/helpers/element-helpers';
import { bootAuthenticatedPage, dismissWalkthroughIfPresent } from '../helpers/core-rpc';

interface CaptureState {
  permissionRequests: number;
  recordingsStarted: number;
  recordingsStopped: number;
  tracksStopped: number;
  sttSettled: number;
}

interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

type VoiceCapability = 'available' | 'unavailable' | 'missing';

/** Install before bootstrap: the suite never opens an actual microphone. */
async function installFakeCapture(
  page: Page,
  options: { permissionDenied?: boolean; unsupported?: boolean } = {}
): Promise<void> {
  await page.route(
    url =>
      ['http:', 'https:'].includes(url.protocol) &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    route => route.abort()
  );
  await page.addInitScript(({ permissionDenied, unsupported }) => {
    const state: CaptureState = {
      permissionRequests: 0,
      recordingsStarted: 0,
      recordingsStopped: 0,
      tracksStopped: 0,
      sttSettled: 0,
    };
    (window as unknown as { __dictationCapture: CaptureState }).__dictationCapture = state;

    // Observe STT settlement so cancellation assertions wait for the late
    // response (or its abort), rather than passing before it reaches the app.
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      let isStt = false;
      if (typeof init?.body === 'string') {
        try {
          isStt = JSON.parse(init.body).method === 'openhuman.voice_stt_dispatch';
        } catch {}
      }
      const response = originalFetch(input, init);
      if (!isStt) return response;
      return response.then(
        reply => {
          const originalJson = reply.json.bind(reply);
          reply.json = () => originalJson().finally(() => (state.sttSettled += 1));
          return reply;
        },
        error => {
          state.sttSettled += 1;
          throw error;
        }
      );
    };

    const mediaDevices = new EventTarget();
    Object.assign(mediaDevices, {
      enumerateDevices: async () => [],
      getUserMedia: async () => {
        state.permissionRequests += 1;
        if (permissionDenied) {
          throw new DOMException('Microphone permission denied by browser mock', 'NotAllowedError');
        }
        const track = Object.assign(new EventTarget(), {
          kind: 'audio',
          enabled: true,
          readyState: 'live',
          stop() {
            if (this.readyState === 'ended') return;
            this.readyState = 'ended';
            state.tracksStopped += 1;
          },
        });
        return { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
      },
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(mime: string): boolean {
        return mime.startsWith('audio/webm');
      }

      state = 'inactive';
      mimeType: string;
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType ?? 'audio/webm';
      }

      start(): void {
        this.state = 'recording';
        state.recordingsStarted += 1;
      }

      stop(): void {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        state.recordingsStopped += 1;
        queueMicrotask(() => {
          const data = new BlobEvent('dataavailable', {
            data: new Blob(['fake microphone audio'], { type: this.mimeType }),
          });
          this.dispatchEvent(data);
          this.ondataavailable?.(data);
          const stopped = new Event('stop');
          this.dispatchEvent(stopped);
          this.onstop?.(stopped);
        });
      }
    }

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: unsupported ? undefined : FakeMediaRecorder,
    });
  }, options);
}

async function captureState(page: Page): Promise<CaptureState> {
  return page.evaluate(
    () => (window as unknown as { __dictationCapture: CaptureState }).__dictationCapture
  );
}

async function mockDictationRpc(
  page: Page,
  options: { capability?: VoiceCapability; holdTranscript?: boolean } = {}
): Promise<{
  voiceStatusCalls: RpcCall[];
  sttCalls: RpcCall[];
  sentMessages: string[];
  setCapability: (capability: VoiceCapability) => void;
  releaseTranscript: (text: string) => Promise<void>;
}> {
  let capability = options.capability ?? 'available';
  const voiceStatusCalls: RpcCall[] = [];
  const sttCalls: RpcCall[] = [];
  const sentMessages: string[] = [];
  let resolveTranscript: ((text: string) => void) | undefined;
  const transcript = options.holdTranscript
    ? new Promise<string>(resolve => (resolveTranscript = resolve))
    : Promise.resolve('dictated final words');

  await page.route('**/rpc', async (route, request) => {
    const body = JSON.parse(request.postData() || '{}');
    const fulfill = (result: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      });

    if (body.method === 'openhuman.voice_status') {
      voiceStatusCalls.push({ method: body.method, params: body.params });
      if (capability === 'missing') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'unknown method: openhuman.voice_status' },
          }),
        });
      } else {
        await fulfill({
          stt_available: capability !== 'unavailable',
          tts_available: true,
          stt_engine: 'hosted',
          stt_error: null,
        });
      }
      return;
    }
    if (body.method === 'openhuman.voice_stt_dispatch') {
      sttCalls.push({ method: body.method, params: body.params });
      const text = await transcript;
      // A canceled fetch may have closed its route while the result was held.
      await fulfill({ text, provider: 'configured-stt' }).catch(() => {});
      return;
    }
    if (body.method === 'openhuman.channel_web_chat') {
      sentMessages.push(String(body.params.message));
      await fulfill({ accepted: true });
      return;
    }
    await route.fallback();
  });

  return {
    voiceStatusCalls,
    sttCalls,
    sentMessages,
    setCapability: next => {
      capability = next;
    },
    releaseTranscript: async text => {
      resolveTranscript?.(text);
      await expect.poll(async () => (await captureState(page)).sttSettled).toBe(1);
    },
  };
}

async function openChat(page: Page, userId: string): Promise<WebTestElement> {
  await bootAuthenticatedPage(page, userId, '/chat');
  await dismissWalkthroughIfPresent(page);
  const input = webElements(page).byTestId('chat-message-input');
  await expect.poll(() => input.isVisible()).toBe(true);
  await createNewThread(page);
  await expect.poll(() => input.isVisible()).toBe(true);
  await input.clearComposer();
  return input;
}

async function waitForSocketConnected(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const store = (
          window as unknown as {
            __OPENHUMAN_STORE__?: {
              getState: () => { socket?: { byUser?: Record<string, { status?: string }> } };
            };
          }
        ).__OPENHUMAN_STORE__;
        return Object.values(store?.getState().socket?.byUser ?? {}).some(
          entry => entry.status === 'connected'
        );
      })
    )
    .toBe(true);
}

async function createNewThread(page: Page): Promise<void> {
  const before = page.url();
  const sidebarButton = webElements(page).byTestId('new-thread-sidebar-button');
  if (await sidebarButton.isVisible().catch(() => false)) {
    await sidebarButton.click();
  } else {
    await webElements(page).byTestId('new-thread-button').click();
  }
  await expect.poll(() => page.url()).not.toBe(before);
  await expect.poll(() => webElements(page).byTestId('chat-message-input').isVisible()).toBe(true);
}

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
