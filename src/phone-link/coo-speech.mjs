import WebSocket from 'ws';

const petStatePath = '/api/webui/providers/world%3Adesktop-pet/panels/pet/state';
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class CooSpeechTarget {
  socket = null;
  connecting = null;
  generation = 0;

  constructor(consoleOrigin) { this.consoleOrigin = consoleOrigin; }

  ensure(cookie) {
    if (!this.connecting) {
      this.connecting = this.prepare(cookie, this.generation).finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async prepare(cookie, generation) {
    const url = this.consoleOrigin + petStatePath;
    const response = await fetch(url, {
      headers:cookie ? {cookie} : {}, redirect:'error', signal:AbortSignal.timeout(2500),
    });
    if (!response.ok) throw Error('Coo 桌宠接口暂时不可用，请检查桌宠 World 是否启用。');
    const {connected,url:petUrl} = await response.json();
    if (this.generation !== generation) throw Error('Coo 聊天连接已关闭。');
    if (connected) return;
    if (!petUrl) throw Error('Coo 桌宠服务还没启动。');
    const pet = new URL(petUrl);
    if (pet.protocol !== 'http:' || !loopback.has(pet.hostname) || pet.username || pet.password) {
      throw Error('Coo 桌宠服务地址无效。');
    }
    const socket = new WebSocket('ws://' + pet.host + '/socket?role=pet&host=tab', {
      handshakeTimeout:3500, maxPayload:4*1024*1024,
    });
    this.socket?.terminate();
    this.socket = socket;
    // Keep a speech destination while the phone is active. The chat stream
    // supplies the recorded lines, so this socket never reports motion or position.
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });
    await new Promise((resolve, reject) => {
      const ready = () => { socket.off('error', failed); socket.off('close', failed); resolve(); };
      const failed = () => { socket.off('open', ready); reject(Error('Coo 暂时没有可用的回复通道。')); };
      socket.once('open', ready);
      socket.once('error', failed);
      socket.once('close', failed);
    });
  }

  release() {
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }
}
