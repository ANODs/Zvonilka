// Звук ретранслятора (web/relay.js): снять с микрофона и проиграть пришедшее.
// Работает в отдельном потоке звука браузера, поэтому не заикается, когда страница занята.

// Отдаёт главному потоку каждый кусок сигнала с микрофона.
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}

// Играет пришедшие куски по очереди. Начинает, когда накопится 80 мс (сглаживает рывки сети),
// и выбрасывает старое, если очередь выросла больше 400 мс (иначе задержка копилась бы).
class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];
    this.off = 0;
    this.size = 0;
    this.started = false;
    this.port.onmessage = (e) => {
      this.q.push(e.data);
      this.size += e.data.length;
      while (this.size > sampleRate * 0.4 && this.q.length > 1) {
        this.size -= this.q.shift().length - this.off;
        this.off = 0;
      }
    };
  }

  process(_, outputs) {
    const out = outputs[0][0];
    if (!this.started) {
      if (this.size < sampleRate * 0.08) { out.fill(0); return true; }
      this.started = true;
    }
    let i = 0;
    while (i < out.length && this.q.length) {
      const d = this.q[0];
      const n = Math.min(out.length - i, d.length - this.off);
      out.set(d.subarray(this.off, this.off + n), i);
      i += n;
      this.off += n;
      this.size -= n;
      if (this.off >= d.length) { this.q.shift(); this.off = 0; }
    }
    if (i < out.length) { out.fill(0, i); this.started = false; } // очередь кончилась — ждём новую порцию
    return true;
  }
}

registerProcessor('zv-capture', Capture);
registerProcessor('zv-play', Play);
