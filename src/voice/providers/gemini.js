import WebSocket from 'ws';
import { VoiceProvider } from './base.js';

// Google Gemini Live API (BidiGenerateContent over WebSocket)
// Docs: https://ai.google.dev/gemini-api/docs/live
export class GeminiLiveProvider extends VoiceProvider {
  static inputRate = 16000;
  static outputRate = 24000;

  async connect({ systemPrompt, kickoff }) {
    const e = this.engine;
    if (!e.api_key) throw new Error('Gemini API key is not set for this engine (Admin > AI Engines).');
    const base = e.base_url || 'wss://generativelanguage.googleapis.com';
    const url = `${base}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(e.api_key)}`;
    const model = e.model.startsWith('models/') ? e.model : `models/${e.model}`;
    const extra = e.extra_config || {};

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Gemini Live setup timed out')); ws.close(); } }, 15000);

      ws.on('open', () => {
        const speechConfig = {};
        if (e.voice) speechConfig.voiceConfig = { prebuiltVoiceConfig: { voiceName: e.voice } };
        if (e.language_code) speechConfig.languageCode = e.language_code;
        const setup = {
          model,
          generationConfig: {
            responseModalities: ['AUDIO'],
            temperature: Number(e.temperature ?? 0.7),
            speechConfig,
            ...(extra.generationConfig || {}),
          },
          systemInstruction: { parts: [{ text: systemPrompt }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(extra.setup || {}), // e.g. { realtimeInputConfig: {...}, contextWindowCompression: {...} }
        };
        ws.send(JSON.stringify({ setup }));
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.setupComplete) {
          if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          this.emit('ready');
          if (kickoff) this.sendText(kickoff);
          return;
        }
        const sc = msg.serverContent;
        if (sc) {
          if (sc.interrupted) this.emit('interrupted');
          for (const part of sc.modelTurn?.parts || []) {
            if (part.inlineData?.data) this.emit('audio', part.inlineData.data);
          }
          if (sc.inputTranscription?.text) this.emit('transcript', { role: 'user', text: sc.inputTranscription.text });
          if (sc.outputTranscription?.text) this.emit('transcript', { role: 'tutor', text: sc.outputTranscription.text });
          if (sc.turnComplete) this.emit('turn_complete');
        }
        if (msg.goAway) this.emit('error', new Error('Gemini session ending soon (goAway)'));
        if (msg.error) this.emit('error', new Error(msg.error.message || 'Gemini error'));
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        const why = reason?.toString() || `code ${code}`;
        if (!settled) { settled = true; reject(new Error(`Gemini closed: ${why}`)); }
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
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: `audio/pcm;rate=${this.inputRate}` } } }));
  }

  sendText(text) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}
