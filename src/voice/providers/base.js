import { EventEmitter } from 'node:events';

/**
 * Every voice provider adapter extends this and normalises its events to:
 *   'ready'         ()                       provider session is set up
 *   'audio'         (base64Pcm16)            tutor audio chunk at `outputRate`
 *   'transcript'    ({ role, text })         role: 'user' | 'tutor' (incremental pieces)
 *   'turn_complete' ()
 *   'interrupted'   ()                       learner barged in, client must stop playback
 *   'error'         (Error)
 *   'close'         (reason)
 *
 * And accepts:
 *   connect({ systemPrompt, kickoff })
 *   sendAudio(base64Pcm16)   learner mic audio at `inputRate`, 16-bit little-endian mono
 *   sendText(text)
 *   close()
 *
 * To add a new provider (e.g. Azure, ElevenLabs, Sarvam): create a file here, extend
 * VoiceProvider, and register it in providers/index.js. No frontend changes are needed.
 */
export class VoiceProvider extends EventEmitter {
  static inputRate = 16000;
  static outputRate = 24000;

  constructor(engine) {
    super();
    this.engine = engine; // row from llm_engines with decrypted api_key and parsed extra_config
  }

  get inputRate() { return this.constructor.inputRate; }
  get outputRate() { return this.constructor.outputRate; }

  // eslint-disable-next-line no-unused-vars
  async connect(_opts) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  sendAudio(_b64) {}
  // eslint-disable-next-line no-unused-vars
  sendText(_text) {}
  close() {}
}
