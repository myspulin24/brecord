// Hidden recorder page: opens the microphone (getUserMedia) and, where the
// main process doesn't capture it natively, system audio (getDisplayMedia with
// loopback). Both feed an AudioWorklet that produces 16 kHz stereo PCM and
// live levels. Also runs the microphone test ("monitor") in Settings.
'use strict';

const host = window.recorderHost;
const SAMPLE_RATE = 16000;

// One audio graph per session; "record" and "monitor" never run at once.
let session = null;
let stopping = false;

function describe(err) {
  if (!err) return 'neznámá chyba';
  if (err.name === 'NotAllowedError') return 'přístup byl odepřen';
  if (err.name === 'NotFoundError') return 'zařízení nebylo nalezeno';
  if (err.name === 'NotReadableError') return 'zařízení je obsazené nebo ho blokuje systém';
  if (err.name === 'OverconstrainedError') return 'vybrané zařízení není k dispozici';
  return err.message || err.name || String(err);
}

async function openMic(deviceId) {
  const audio = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio, video: false }), fellBack: false };
  } catch (err) {
    if (!deviceId || err.name === 'NotAllowedError') throw err;
    // The chosen microphone was unplugged: fall back to the default one.
    delete audio.deviceId;
    return { stream: await navigator.mediaDevices.getUserMedia({ audio, video: false }), fellBack: true };
  }
}

async function openSystemAudio() {
  // Chromium requires a video track for getDisplayMedia; ask for a small one.
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 320, height: 180, frameRate: 1 } });
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('systém neposkytl zvukovou stopu');
  }
  if (audioTracks[0].readyState === 'ended') {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('zvukový stream se okamžitě ukončil (zkontrolujte oprávnění k nahrávání systémového zvuku)');
  }
  // On macOS the loopback audio rides on the screen capture session, so keep
  // the (1 fps) video track alive there; elsewhere it can go.
  if (host.platform !== 'darwin') {
    for (const t of stream.getVideoTracks()) {
      t.stop();
      stream.removeTrack(t);
    }
  }
  audioTracks[0].addEventListener('ended', () => {
    if (!stopping) host.event({ type: 'warning', message: 'Nahrávání systémového zvuku se zastavilo' });
  });
  return stream;
}

async function createGraph(emitChunks) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
  await ctx.audioWorklet.addModule('recorder-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-recorder', {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { emitChunks },
  });
  // The worklet has to be pulled by the graph; route it to a muted sink.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  const s = { ctx, node, emitChunks, micStream: null, micSource: null, displayStream: null, onflushed: null };
  node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'chunk') host.chunk({ pcm: new Uint8Array(m.pcm.buffer), micPeak: m.micPeak, sysPeak: m.sysPeak });
    else if (m.type === 'level') host.event({ type: 'level', mic: m.mic, sys: m.sys, monitor: !emitChunks });
    else if (m.type === 'flushed' && s.onflushed) s.onflushed();
  };
  return s;
}

function attachMic(s, stream) {
  s.micStream = stream;
  s.micSource = s.ctx.createMediaStreamSource(stream);
  s.micSource.connect(s.node, 0, 0);
  const track = stream.getAudioTracks()[0];
  track.addEventListener('ended', async () => {
    if (stopping || session !== s) return;
    // Headset unplugged mid-meeting: switch to whatever the default mic is now.
    try {
      s.micSource.disconnect();
      const { stream: next } = await openMic('');
      attachMic(s, next);
      host.event({ type: 'warning', message: `Mikrofon přepnut na ${next.getAudioTracks()[0].label || 'výchozí zařízení'}` });
    } catch (err) {
      host.event({ type: 'warning', message: `Mikrofon se odpojil: ${describe(err)}` });
    }
  });
  return track.label;
}

async function teardown() {
  const s = session;
  session = null;
  if (!s) return;
  for (const st of [s.micStream, s.displayStream]) if (st) st.getTracks().forEach((t) => t.stop());
  s.node.port.onmessage = null;
  await s.ctx.close().catch(() => {});
}

async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

const handlers = {
  // args: { micDeviceId, systemAudio: 'loopback' | 'none', externalSystem }
  // externalSystem: the main process captures system audio itself and fills
  // the right channel, using our chunks as the clock.
  async start(args) {
    await teardown();
    stopping = false;
    const s = await createGraph(true);
    session = s;
    const status = { mic: false, system: false, micLabel: null, errors: [] };
    try {
      const { stream, fellBack } = await openMic(args.micDeviceId || '');
      status.micLabel = attachMic(s, stream);
      status.mic = true;
      if (fellBack) status.errors.push({ source: 'mic', message: `Vybraný mikrofon není připojený, nahrávám z výchozího (${status.micLabel})`, soft: true });
    } catch (err) {
      status.errors.push({ source: 'mic', message: `Mikrofon není k dispozici: ${describe(err)}` });
    }
    if (args.systemAudio === 'loopback') {
      try {
        s.displayStream = await openSystemAudio();
        const src = s.ctx.createMediaStreamSource(new MediaStream(s.displayStream.getAudioTracks()));
        src.connect(s.node, 0, 1);
        status.system = true;
      } catch (err) {
        status.errors.push({ source: 'system', message: `Systémový zvuk není k dispozici: ${describe(err)}` });
      }
    }
    if (!status.mic && !status.system && !args.externalSystem) {
      await teardown();
      return status;
    }
    await s.ctx.resume();
    return status;
  },

  async stop() {
    stopping = true;
    const s = session;
    if (s && s.emitChunks) {
      await new Promise((resolve) => {
        s.onflushed = resolve;
        s.node.port.postMessage('flush');
        setTimeout(resolve, 2000);
      });
    }
    await teardown();
    return {};
  },

  // Microphone test: levels only, nothing is written anywhere.
  async monitor(args) {
    if (session && session.emitChunks) return { ok: false, error: 'Probíhá nahrávání' };
    await teardown();
    const s = await createGraph(false);
    session = s;
    try {
      const { stream } = await openMic(args.micDeviceId || '');
      const label = attachMic(s, stream);
      await s.ctx.resume();
      return { ok: true, label };
    } catch (err) {
      await teardown();
      return { ok: false, error: describe(err), denied: err.name === 'NotAllowedError' };
    }
  },

  async monitorStop() {
    if (session && !session.emitChunks) await teardown();
    return {};
  },

  // Opens and immediately closes the microphone, to trigger / verify access.
  async probeMic(args) {
    try {
      const { stream } = await openMic(args.micDeviceId || '');
      const label = stream.getAudioTracks()[0].label;
      stream.getTracks().forEach((t) => t.stop());
      return { ok: true, label, devices: await listMics() };
    } catch (err) {
      return { ok: false, error: describe(err), denied: err.name === 'NotAllowedError' };
    }
  },

  devices: listMics,
};

host.onCommand(async ({ id, cmd, args }) => {
  try {
    const result = await handlers[cmd](args || {});
    host.reply(id, { result });
  } catch (err) {
    host.reply(id, { error: describe(err) });
  }
});

navigator.mediaDevices.addEventListener('devicechange', async () => {
  try {
    host.event({ type: 'devices', devices: await listMics() });
  } catch {
    // ignore
  }
});
