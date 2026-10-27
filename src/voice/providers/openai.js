import WebSocket from 'ws';
import { VoiceProvider } from './base.js';

// OpenAI Realtime API over WebSocket. Handles both GA ("gpt-realtime") and beta event names.
// Docs: https://platform.openai.com/docs/guides/realtime
export class OpenAIRealtimeProvider extends VoiceProvider {
  static inputRate = 24000;
  static outputRate = 24000;

  async connect({ systemPrompt, kickoff }) {
    const e = this.engine;
    if (!e.api_key) throw new Error('OpenAI API key is not set for this engine (Admin > AI Engines).');
    const base = e.base_url || 'wss://api.openai.com/v1/realtime';
    const url = `${base}?model=${encodeURIComponent(e.model)}`;
    const extra = e.extra_config || {};
    const beta = Boolean(extra.beta) || /preview/.test(e.model);

    return new Promise((resolve, reject) => {
      const headers = { Authorization: `Bearer ${e.api_key}` };
      if (beta) headers['OpenAI-Beta'] = 'realtime=v1';
      const ws = new WebSocket(url, { headers });
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('OpenAI Realtime setup timed out')); ws.close(); } }, 15000);

      ws.on('open', () => {
        const session = beta
          ? {
              instructions: systemPrompt, voice: e.voice || 'alloy', modalities: ['audio', 'text'],
              input_audio_format: 'pcm16', output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad' },
              temperature: Math.max(0.6, Number(e.temperature ?? 0.8)),
            }
          : {
              type: 'realtime', instructions: systemPrompt, output_modalities: ['audio'],
              audio: {
                input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'server_vad' } },
                output: { format: { type: 'audio/pcm', rate: 24000 }, voice: e.voice || 'marin' },
              },
            };
        ws.send(JSON.stringify({ type: 'session.update', session: { ...session, ...(extra.session || {}) } }));
      });

      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        switch (m.type) {
          case 'session.updated':
            if (!settled) {
              settled = true; clearTimeout(timer); resolve();
              this.emit('ready');
              if (kickoff) this.sendText(kickoff);
            }
            break;
          case 'response.output_audio.delta':
          case 'response.audio.delta':
            if (m.delta) this.emit('audio', m.delta);
            break;
          case 'response.output_audio_transcript.delta':
          case 'response.audio_transcript.delta':
            if (m.delta) this.emit('transcript', { role: 'tutor', text: m.delta });
            break;
          case 'conversation.item.input_audio_transcription.completed':
            if (m.transcript) this.emit('transcript', { role: 'user', text: m.transcript });
            break;
          case 'input_audio_buffer.speech_started':
            this.emit('interrupted');
            break;
          case 'response.done':
            this.emit('turn_complete');
            break;
          case 'error':
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error(m.error?.message || 'OpenAI error')); }
            else this.emit('error', new Error(m.error?.message || 'OpenAI error'));
            break;
          default:
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        const why = reason?.toString() || `code ${code}`;
        if (!settled) { settled = true; reject(new Error(`OpenAI closed: ${why}`)); }
        this.emit('close', why);
      });
      ws.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        else this.emit('error', err);
      });
    });
  }

  sendAudio(b64) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
  }

  sendText(text) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
    this.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}
