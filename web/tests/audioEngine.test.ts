import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  AudioEngine,
  DEFAULT_DRUM_SAMPLES,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  type AudioParamLike,
  type FetchLike,
  type GainNodeLike,
  type InteractionEventTargetLike,
} from '../src/audio/index.ts';
import { Sequencer, type SequencerTimer } from '../src/sequencer/sequencer.ts';

class FakeAudioParam implements AudioParamLike {
  value: number;

  constructor(initialValue: number) {
    this.value = initialValue;
  }

  setValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeAudioNode {
  readonly connectedTo = new Set<FakeAudioNode>();
  disconnected = false;

  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connectedTo.add(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
    this.connectedTo.clear();
  }

  reaches(target: FakeAudioNode): boolean {
    const visited = new Set<FakeAudioNode>();
    const queue: FakeAudioNode[] = [this];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node === target) {
        return true;
      }
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);
      for (const next of node.connectedTo) {
        queue.push(next);
      }
    }
    return false;
  }
}

class FakeGainNode extends FakeAudioNode implements GainNodeLike<FakeAudioNode> {
  readonly gain = new FakeAudioParam(1);
}

interface FakeAudioBuffer extends AudioBufferLike {
  readonly tag: string;
}

class FakeBufferSourceNode
  extends FakeAudioNode
  implements AudioBufferSourceNodeLike<FakeAudioNode, FakeAudioBuffer>
{
  buffer: FakeAudioBuffer | null = null;
  started = false;
  startArgs: { when?: number; offset?: number; duration?: number } | null = null;
  readonly #endedListeners: Array<() => void> = [];

  start(when?: number, offset?: number, duration?: number): void {
    if (this.started) {
      throw new Error('Source already started');
    }
    this.started = true;
    this.startArgs = { when, offset, duration };
  }

  stop(): void {
    this.emitEnded();
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') {
      this.#endedListeners.push(listener);
    }
  }

  emitEnded(): void {
    const callbacks = this.#endedListeners.splice(0);
    for (const cb of callbacks) {
      cb();
    }
  }
}

class FakeAudioContext implements AudioContextLike<FakeAudioNode, FakeAudioBuffer> {
  state: AudioContextState;
  currentTime = 0;
  readonly destination = new FakeAudioNode();
  readonly gainNodes: FakeGainNode[] = [];
  readonly sourceNodes: FakeBufferSourceNode[] = [];
  decodeCalls = 0;
  resumeCalls = 0;
  suspendCalls = 0;
  failDecode = false;

  constructor(initialState: AudioContextState = 'running') {
    this.state = initialState;
  }

  createBufferSource(): FakeBufferSourceNode {
    const source = new FakeBufferSourceNode();
    this.sourceNodes.push(source);
    return source;
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gainNodes.push(gain);
    return gain;
  }

  async decodeAudioData(audioData: ArrayBuffer): Promise<FakeAudioBuffer> {
    this.decodeCalls += 1;
    if (this.failDecode || audioData.byteLength === 0) {
      throw new Error('Failed to decode audio buffer');
    }
    const bytes = new Uint8Array(audioData);
    let checksum = 0;
    for (const byte of bytes) {
      checksum = (checksum * 31 + byte) >>> 0;
    }
    return {
      tag: `${audioData.byteLength}:${checksum.toString(16)}`,
      duration: 0.25,
      length: 11_025,
      sampleRate: 44_100,
      numberOfChannels: 1,
    };
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.state !== 'closed') {
      this.state = 'running';
    }
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    if (this.state !== 'closed') {
      this.state = 'suspended';
    }
  }
}

class FakeInteractionTarget implements InteractionEventTargetLike {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    const fakeEvent = {} as Event;
    for (const listener of Array.from(bucket)) {
      if (typeof listener === 'function') {
        listener(fakeEvent);
      } else {
        listener.handleEvent(fakeEvent);
      }
    }
  }

  get totalListenerCount(): number {
    let count = 0;
    for (const bucket of this.listeners.values()) {
      count += bucket.size;
    }
    return count;
  }
}

class ManualTimer implements SequencerTimer {
  #nextId = 1;
  readonly #tasks = new Map<number, { cb: () => void; intervalMs: number; nextMs: number }>();
  #nowMs = 0;

  setInterval(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#tasks.set(id, { cb: callback, intervalMs: delayMs, nextMs: this.#nowMs + delayMs });
    return id;
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') {
      this.#tasks.delete(handle);
    }
  }

  advanceBy(deltaMs: number): void {
    const targetMs = this.#nowMs + deltaMs;
    while (true) {
      let chosenId: number | null = null;
      let earliest = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.#tasks) {
        if (task.nextMs <= targetMs && task.nextMs < earliest) {
          chosenId = id;
          earliest = task.nextMs;
        }
      }
      if (chosenId === null) {
        break;
      }
      const task = this.#tasks.get(chosenId)!;
      this.#nowMs = earliest;
      task.nextMs += task.intervalMs;
      task.cb();
    }
    this.#nowMs = targetMs;
  }
}

function createBundledDiskFetch(recordedUrls?: string[]): FetchLike {
  return async (url: string): Promise<Response> => {
    recordedUrls?.push(url);
    const relativePath = url.replace(/^\//, '');
    const fileUrl = new URL(`../public/${relativePath}`, import.meta.url);
    if (!existsSync(fileUrl)) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    const bytes = readFileSync(fileUrl);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Response(copy.buffer, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    });
  };
}

describe('Web Audio Drum Engine (REQ-003 / #4)', () => {
  it('bundles local, valid, pairwise-distinct synthetic WAV drum samples with zero external URLs', () => {
    const expectedIds = ['kick', 'snare', 'hihat-closed', 'hihat-open', 'clap'];
    assert.deepEqual(Object.keys(DEFAULT_DRUM_SAMPLES), expectedIds);

    const hashes = new Set<string>();
    for (const [soundId, sampleUrl] of Object.entries(DEFAULT_DRUM_SAMPLES)) {
      assert.equal(sampleUrl, `/samples/${soundId}.wav`);
      assert.equal(sampleUrl.startsWith('/samples/'), true);

      const fileUrl = new URL(`../public${sampleUrl}`, import.meta.url);
      assert.equal(existsSync(fileUrl), true, `Missing bundled sample file for ${soundId}`);

      const bytes = readFileSync(fileUrl);
      assert.equal(bytes.byteLength > 44, true);

      // Verify RIFF....WAVEfmt PCM header
      const headerAscii = String.fromCharCode(
        bytes[0]!,
        bytes[1]!,
        bytes[2]!,
        bytes[3]!,
        bytes[8]!,
        bytes[9]!,
        bytes[10]!,
        bytes[11]!,
      );
      assert.equal(headerAscii, 'RIFFWAVE');

      let fnv = 0x811c9dc5;
      for (const byte of bytes) {
        fnv ^= byte;
        fnv = Math.imul(fnv, 0x01000193) >>> 0;
      }
      hashes.add(`${bytes.byteLength}:${fnv.toString(16)}`);
    }

    assert.equal(hashes.size, expectedIds.length);
  });

  it('loads and caches decoded AudioBuffers asynchronously without duplicate fetches or decodes', async () => {
    let contextCreatedCount = 0;
    const context = new FakeAudioContext();
    const fetchedUrls: string[] = [];

    const engine = new AudioEngine<FakeAudioNode, FakeAudioBuffer>({
      createAudioContext: () => {
        contextCreatedCount += 1;
        return context;
      },
      fetchImpl: createBundledDiskFetch(fetchedUrls),
      interactionTarget: null,
    });

    assert.equal(engine.isReady, false);

    // Concurrent load calls should deduplicate in-flight requests and decode each sample once
    await Promise.all([engine.load(), engine.load()]);

    assert.equal(engine.isReady, true);
    assert.equal(contextCreatedCount, 1);
    assert.equal(fetchedUrls.length, 5);
    assert.equal(context.decodeCalls, 5);
    for (const id of ['kick', 'snare', 'hihat-closed', 'hihat-open', 'clap']) {
      assert.equal(engine.hasSound(id), true);
    }

    // Subsequent load() resolves from cache with zero additional fetches or decodes
    await engine.load();
    assert.equal(fetchedUrls.length, 5);
    assert.equal(context.decodeCalls, 5);
  });

  it('plays distinct sounds connected to destination and supports velocity and offset options', async () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine<FakeAudioNode, FakeAudioBuffer>({
      createAudioContext: () => context,
      fetchImpl: createBundledDiskFetch(),
      interactionTarget: null,
    });

    await engine.load(['kick', 'snare']);

    assert.equal(engine.play('kick'), true);
    assert.equal(engine.play('snare', { velocity: 0.4, offset: 0.05 }), true);
    assert.equal(context.sourceNodes.length, 2);

    const kickSource = context.sourceNodes[0]!;
    const snareSource = context.sourceNodes[1]!;

    assert.notEqual(kickSource.buffer?.tag, snareSource.buffer?.tag);
    assert.equal(kickSource.reaches(context.destination), true);
    assert.equal(snareSource.reaches(context.destination), true);
    assert.deepEqual(kickSource.startArgs, { when: 0, offset: undefined, duration: undefined });
    assert.deepEqual(snareSource.startArgs, { when: 0, offset: 0.05, duration: undefined });

    // GainNodes: [0] is masterGainNode (1.0), [1] is snare per-voice velocity gain (0.4)
    assert.equal(context.gainNodes.length, 2);
    assert.equal(context.gainNodes[0]!.gain.value, 1);
    assert.equal(context.gainNodes[1]!.gain.value, 0.4);

    // Emit ended event to verify cleanup disconnect
    snareSource.emitEnded();
    assert.equal(snareSource.disconnected, true);
    assert.equal(context.gainNodes[1]!.disconnected, true);
  });

  it('supports setMasterGain, mute, and unmute while preserving configured master gain', async () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine<FakeAudioNode, FakeAudioBuffer>({
      createAudioContext: () => context,
      fetchImpl: createBundledDiskFetch(),
      interactionTarget: null,
    });

    await engine.load(['kick']);
    const masterGainNode = context.gainNodes[0]!;

    engine.setMasterGain(0.65);
    assert.equal(engine.masterGain, 0.65);
    assert.equal(masterGainNode.gain.value, 0.65);

    // Clamps out-of-range values and ignores NaN
    engine.setMasterGain(2.5);
    assert.equal(engine.masterGain, 1);
    engine.setMasterGain(-0.5);
    assert.equal(engine.masterGain, 0);
    engine.setMasterGain(0.75);
    engine.setMasterGain(Number.NaN);
    assert.equal(engine.masterGain, 0.75);

    engine.mute();
    assert.equal(engine.isMuted, true);
    assert.equal(engine.masterGain, 0.75);
    assert.equal(masterGainNode.gain.value, 0);

    // Updating masterGain while muted keeps output at 0 until unmuted
    engine.setMasterGain(0.5);
    assert.equal(masterGainNode.gain.value, 0);

    engine.unmute();
    assert.equal(engine.isMuted, false);
    assert.equal(masterGainNode.gain.value, 0.5);
  });

  it('supports suspend, resume, and automatic resume on first user interaction', async () => {
    const context = new FakeAudioContext('suspended');
    const interactionTarget = new FakeInteractionTarget();
    const engine = new AudioEngine<FakeAudioNode, FakeAudioBuffer>({
      createAudioContext: () => context,
      fetchImpl: createBundledDiskFetch(),
      interactionTarget,
    });

    await engine.load(['kick']);
    assert.equal(engine.state, 'suspended');
    assert.equal(interactionTarget.totalListenerCount > 0, true);

    // First user interaction unlocks suspended AudioContext and detaches listeners
    interactionTarget.dispatch('pointerdown');
    await Promise.resolve();
    assert.equal(engine.state, 'running');
    assert.equal(context.resumeCalls, 1);
    assert.equal(interactionTarget.totalListenerCount, 0);

    await engine.suspend();
    assert.equal(engine.state, 'suspended');
    assert.equal(context.suspendCalls, 1);

    await engine.resume();
    assert.equal(engine.state, 'running');
    assert.equal(context.resumeCalls, 2);

    // play() also automatically triggers resume if context is suspended
    await engine.suspend();
    assert.equal(engine.state, 'suspended');
    assert.equal(engine.play('kick'), true);
    assert.equal(engine.state, 'running');
  });

  it('handles missing or invalid sound names and failed fetches gracefully without throwing', async () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine<FakeAudioNode, FakeAudioBuffer>({
      createAudioContext: () => context,
      fetchImpl: createBundledDiskFetch(),
      interactionTarget: null,
    });

    assert.equal(engine.play('kick'), false);
    assert.equal(engine.play(''), false);
    assert.equal(engine.play('   '), false);
    assert.equal(engine.play('../outside'), false);
    assert.equal(engine.play('nonexistent-drum'), false);

    await assert.doesNotReject(() => engine.load(['nonexistent-drum', 'kick']));
    assert.equal(engine.hasSound('kick'), true);
    assert.equal(engine.hasSound('nonexistent-drum'), false);
    assert.equal(engine.play('nonexistent-drum'), false);
    assert.equal(engine.play('kick'), true);
  });

  it('triggers active drum sounds in sync with the 16-step Sequencer onStep callback', async () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine<FakeAudioNode, FakeAudioBuffer>({
      createAudioContext: () => context,
      fetchImpl: createBundledDiskFetch(),
      interactionTarget: null,
    });
    await engine.load();

    const triggeredByStep: Array<{ step: number; sounds: string[] }> = [];
    const timer = new ManualTimer();
    const sequencer = new Sequencer({
      timer,
      onStep: (stepIndex, activeInstrumentIds) => {
        const fired: string[] = [];
        for (const id of activeInstrumentIds) {
          if (engine.play(id)) {
            fired.push(id);
          }
        }
        triggeredByStep.push({ step: stepIndex, sounds: fired });
      },
    });

    sequencer.play();
    assert.deepEqual(triggeredByStep[0], { step: 0, sounds: ['kick', 'hihat-closed'] });

    // Step 1 in default pattern is silent
    timer.advanceBy(sequencer.stepIntervalMs);
    assert.deepEqual(triggeredByStep[1], { step: 1, sounds: [] });

    // Advance to step 4 -> kick + snare + hihat-closed
    timer.advanceBy(sequencer.stepIntervalMs * 3);
    assert.deepEqual(triggeredByStep[4], {
      step: 4,
      sounds: ['kick', 'snare', 'hihat-closed'],
    });
  });
});
