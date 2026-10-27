import { GeminiLiveProvider } from './gemini.js';
import { OpenAIRealtimeProvider } from './openai.js';

// Registry of voice engines. Add a new provider here and it appears in Admin > AI Engines.
export const PROVIDERS = {
  gemini_live: {
    label: 'Google Gemini Live',
    Adapter: GeminiLiveProvider,
    models: [
      'gemini-2.5-flash-native-audio-preview-09-2025',
      'gemini-live-2.5-flash-preview',
      'gemini-2.0-flash-live-001',
    ],
    voices: ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Achernar', 'Sulafat'],
    docs: 'https://ai.google.dev/gemini-api/docs/live',
  },
  openai_realtime: {
    label: 'OpenAI Realtime',
    Adapter: OpenAIRealtimeProvider,
    models: ['gpt-realtime', 'gpt-realtime-mini', 'gpt-4o-realtime-preview'],
    voices: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
    docs: 'https://platform.openai.com/docs/guides/realtime',
  },
};

export function createProvider(engine) {
  const p = PROVIDERS[engine.provider];
  if (!p) throw new Error(`Unknown provider "${engine.provider}"`);
  return new p.Adapter(engine);
}

// Opens a session, waits for setup, closes. Used by Admin "Test connection".
export async function testEngine(engine) {
  const started = Date.now();
  const provider = createProvider(engine);
  try {
    await provider.connect({ systemPrompt: 'You are a test. Reply "ok".' });
    return { ok: true, message: `Connected to ${PROVIDERS[engine.provider].label} (${engine.model}) in ${Date.now() - started} ms` };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    provider.close();
  }
}
