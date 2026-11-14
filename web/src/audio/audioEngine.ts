export const DEFAULT_DRUM_SAMPLES: Readonly<Record<string, string>> = {
  kick: '/samples/kick.wav',
  snare: '/samples/snare.wav',
  'hihat-closed': '/samples/hihat-closed.wav',
  'hihat-open': '/samples/hihat-open.wav',
  clap: '/samples/clap.wav',
};

const USER_INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

export interface PlaySoundOptions {
  readonly velocity?: number;
  readonly offset?: number;
}

export interface AudioParamLike {
  value: number;
  setValueAtTime?(value: number, startTime: number): unknown;
}

export interface GainNodeLike<TNode = AudioNode> {
  readonly gain: AudioParamLike;
  connect(destination: TNode): unknown;
  disconnect(): void;
}

export interface AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
}

export interface AudioBufferSourceNodeLike<
  TNode = AudioNode,
  TBuffer extends AudioBufferLike = AudioBuffer,
> {
  buffer: TBuffer | null;
  connect(destination: TNode): unknown;
  disconnect(): void;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  addEventListener?(
    type: string,
    listener: () => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

export interface AudioContextLike<
  TNode = AudioNode,
  TBuffer extends AudioBufferLike = AudioBuffer,
> {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: TNode;
  createBufferSource(): AudioBufferSourceNodeLike<TNode, TBuffer>;
  createGain(): GainNodeLike<TNode>;
  decodeAudioData(audioData: ArrayBuffer): Promise<TBuffer>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close?(): Promise<void>;
}

export interface InteractionEventTargetLike {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AudioEngineSnapshot {
  readonly isReady: boolean;
  readonly isMuted: boolean;
  readonly masterGain: number;
}

export interface AudioEngineOptions<
  TNode = AudioNode,
  TBuffer extends AudioBufferLike = AudioBuffer,
> {
  readonly createAudioContext?: () => AudioContextLike<TNode, TBuffer> | null;
  readonly fetchImpl?: FetchLike;
  readonly sampleUrls?: Readonly<Record<string, string>>;
  readonly interactionTarget?: InteractionEventTargetLike | null;
  readonly initialMasterGain?: number;
}

interface BrowserAudioGlobal {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function createBrowserAudioContext(): AudioContextLike<AudioNode, AudioBuffer> | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as BrowserAudioGlobal;
  const ContextCtor = win.AudioContext ?? win.webkitAudioContext;
  if (!ContextCtor) {
    return null;
  }
  return new ContextCtor();
}

function getDefaultFetch(): FetchLike | null {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    return (input, init) => window.fetch(input, init);
  }
  if (typeof globalThis.fetch === 'function') {
    return (input, init) => globalThis.fetch(input, init);
  }
  return null;
}

function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isValidSoundName(soundName: string): boolean {
  return (
    soundName.length > 0 &&
    soundName.trim() === soundName &&
    !soundName.includes('/') &&
    !soundName.includes('\\') &&
    !soundName.includes('..')
  );
}

function applyGainParam(param: AudioParamLike, value: number, currentTime: number): void {
  param.value = value;
  if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(value, currentTime);
  }
}

export class AudioEngine<
  TNode = AudioNode,
  TBuffer extends AudioBufferLike = AudioBuffer,
> {
  readonly #createAudioContext: () => AudioContextLike<TNode, TBuffer> | null;
  readonly #getFetch: () => FetchLike | null;
  readonly #sampleUrls: Map<string, string>;
  readonly #buffers = new Map<string, TBuffer>();
  readonly #inflightLoads = new Map<string, Promise<TBuffer | null>>();
  readonly #listeners = new Set<() => void>();
  readonly #interactionTarget: InteractionEventTargetLike | null;
  readonly #handleUserInteraction: EventListener;

  #context: AudioContextLike<TNode, TBuffer> | null = null;
  #masterGainNode: GainNodeLike<TNode> | null = null;
  #interactionListenersAttached = false;
  #manuallySuspended = false;
  #snapshot: AudioEngineSnapshot;

  constructor(options: AudioEngineOptions<TNode, TBuffer> = {}) {
    this.#createAudioContext =
      options.createAudioContext ??
      (() => createBrowserAudioContext() as AudioContextLike<TNode, TBuffer> | null);
    this.#getFetch = options.fetchImpl ? () => options.fetchImpl! : getDefaultFetch;
    this.#sampleUrls = new Map(Object.entries(options.sampleUrls ?? DEFAULT_DRUM_SAMPLES));
    this.#interactionTarget =
      options.interactionTarget !== undefined
        ? options.interactionTarget
        : typeof window !== 'undefined'
          ? window
          : null;

    const initialGain =
      options.initialMasterGain !== undefined && Number.isFinite(options.initialMasterGain)
        ? clampUnitInterval(options.initialMasterGain)
        : 1;

    this.#snapshot = {
      isReady: false,
      isMuted: false,
      masterGain: initialGain,
    };

    this.#handleUserInteraction = () => {
      if (this.#manuallySuspended) {
        return;
      }
      const context = this.#ensureContext();
      if (!context) {
        return;
      }
      if (context.state === 'running') {
        this.#detachInteractionListeners();
        return;
      }
      if (context.state === 'suspended') {
        void context
          .resume()
          .then(() => {
            if (context.state === 'running') {
              this.#detachInteractionListeners();
            }
          })
          .catch(() => {
            // Keep listeners attached if browser rejected resume outside an eligible gesture.
          });
      }
    };

    this.enableAutoResume();
  }

  get isReady(): boolean {
    return this.#snapshot.isReady;
  }

  get isMuted(): boolean {
    return this.#snapshot.isMuted;
  }

  get masterGain(): number {
    return this.#snapshot.masterGain;
  }

  get state(): AudioContextState | 'uninitialized' {
    return this.#context?.state ?? 'uninitialized';
  }

  get loadedSounds(): string[] {
    return Array.from(this.#buffers.keys());
  }

  hasSound(soundName: string): boolean {
    return this.#buffers.has(soundName);
  }

  getSnapshot(): AudioEngineSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  enableAutoResume(): void {
    if (this.#context?.state === 'running') {
      return;
    }
    this.#attachInteractionListeners();
  }

  async load(soundNames?: readonly string[]): Promise<void> {
    const requestedNames = soundNames
      ? Array.from(new Set(soundNames))
      : Array.from(this.#sampleUrls.keys());

    if (requestedNames.length === 0) {
      this.#updateSnapshot({ isReady: true });
      return;
    }

    const validNames = requestedNames.filter(isValidSoundName);
    if (validNames.length === 0) {
      return;
    }

    await Promise.all(validNames.map((soundName) => this.#loadSingleSample(soundName)));

    const allValidLoaded = validNames.every((soundName) => this.#buffers.has(soundName));
    if (allValidLoaded && validNames.length === requestedNames.length) {
      this.#updateSnapshot({ isReady: true });
    }
  }

  play(soundName: string, options?: PlaySoundOptions): boolean {
    if (typeof soundName !== 'string' || !isValidSoundName(soundName)) {
      return false;
    }

    const buffer = this.#buffers.get(soundName);
    if (!buffer) {
      return false;
    }

    const context = this.#ensureContext();
    const masterGainNode = this.#masterGainNode;
    if (!context || !masterGainNode || context.state === 'closed') {
      return false;
    }

    if (context.state === 'suspended') {
      this.#manuallySuspended = false;
      void context.resume().catch(() => {});
    }

    const velocity =
      options?.velocity !== undefined && Number.isFinite(options.velocity)
        ? clampUnitInterval(options.velocity)
        : 1;

    try {
      const sourceNode = context.createBufferSource();
      sourceNode.buffer = buffer;

      let voiceGainNode: GainNodeLike<TNode> | null = null;
      if (velocity !== 1) {
        voiceGainNode = context.createGain();
        applyGainParam(voiceGainNode.gain, velocity, context.currentTime);
        sourceNode.connect(voiceGainNode as unknown as TNode);
        voiceGainNode.connect(masterGainNode as unknown as TNode);
      } else {
        sourceNode.connect(masterGainNode as unknown as TNode);
      }

      if (typeof sourceNode.addEventListener === 'function') {
        sourceNode.addEventListener(
          'ended',
          () => {
            sourceNode.disconnect();
            voiceGainNode?.disconnect();
          },
          { once: true },
        );
      }

      if (options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0) {
        const safeOffset = Math.min(options.offset, Math.max(0, buffer.duration));
        sourceNode.start(0, safeOffset);
      } else {
        sourceNode.start(0);
      }

      return true;
    } catch {
      return false;
    }
  }

  setMasterGain(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const clampedGain = clampUnitInterval(value);
    this.#updateSnapshot({ masterGain: clampedGain });
    this.#syncMasterGainNode();
  }

  mute(): void {
    this.#updateSnapshot({ isMuted: true });
    this.#syncMasterGainNode();
  }

  unmute(): void {
    this.#updateSnapshot({ isMuted: false });
    this.#syncMasterGainNode();
  }

  async suspend(): Promise<void> {
    this.#manuallySuspended = true;
    if (!this.#context || this.#context.state === 'closed') {
      return;
    }
    try {
      await this.#context.suspend();
    } catch {
      // Ignore context state transition errors gracefully.
    }
  }

  async resume(): Promise<void> {
    this.#manuallySuspended = false;
    const context = this.#ensureContext();
    if (!context || context.state === 'closed') {
      return;
    }
    try {
      await context.resume();
      if (context.state === 'running') {
        this.#detachInteractionListeners();
      }
    } catch {
      // Ignore browser autoplay rejection outside user gesture.
    }
  }

  dispose(): void {
    this.#detachInteractionListeners();
  }

  #resolveSampleUrl(soundName: string): string {
    const configured = this.#sampleUrls.get(soundName);
    if (configured) {
      return configured;
    }
    const defaultUrl = `/samples/${soundName}.wav`;
    this.#sampleUrls.set(soundName, defaultUrl);
    return defaultUrl;
  }

  async #loadSingleSample(soundName: string): Promise<TBuffer | null> {
    const cached = this.#buffers.get(soundName);
    if (cached) {
      return cached;
    }

    const existingPromise = this.#inflightLoads.get(soundName);
    if (existingPromise) {
      return existingPromise;
    }

    const loadPromise = (async (): Promise<TBuffer | null> => {
      const context = this.#ensureContext();
      const fetchImpl = this.#getFetch();
      if (!context || !fetchImpl) {
        return null;
      }

      const url = this.#resolveSampleUrl(soundName);
      try {
        const response = await fetchImpl(url);
        if (!response.ok) {
          return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength === 0) {
          return null;
        }
        const decoded = await context.decodeAudioData(arrayBuffer);
        this.#buffers.set(soundName, decoded);
        return decoded;
      } catch {
        return null;
      } finally {
        this.#inflightLoads.delete(soundName);
      }
    })();

    this.#inflightLoads.set(soundName, loadPromise);
    return loadPromise;
  }

  #ensureContext(): AudioContextLike<TNode, TBuffer> | null {
    if (this.#context && this.#context.state !== 'closed') {
      return this.#context;
    }

    try {
      const created = this.#createAudioContext();
      if (!created) {
        return null;
      }
      const masterGainNode = created.createGain();
      const effectiveGain = this.#snapshot.isMuted ? 0 : this.#snapshot.masterGain;
      applyGainParam(masterGainNode.gain, effectiveGain, created.currentTime);
      masterGainNode.connect(created.destination);

      this.#context = created;
      this.#masterGainNode = masterGainNode;
      return created;
    } catch {
      return null;
    }
  }

  #syncMasterGainNode(): void {
    if (!this.#context || !this.#masterGainNode) {
      return;
    }
    const effectiveGain = this.#snapshot.isMuted ? 0 : this.#snapshot.masterGain;
    applyGainParam(this.#masterGainNode.gain, effectiveGain, this.#context.currentTime);
  }

  #attachInteractionListeners(): void {
    if (this.#interactionListenersAttached || !this.#interactionTarget) {
      return;
    }
    for (const eventName of USER_INTERACTION_EVENTS) {
      this.#interactionTarget.addEventListener(eventName, this.#handleUserInteraction, {
        passive: true,
      });
    }
    this.#interactionListenersAttached = true;
  }

  #detachInteractionListeners(): void {
    if (!this.#interactionListenersAttached || !this.#interactionTarget) {
      return;
    }
    for (const eventName of USER_INTERACTION_EVENTS) {
      this.#interactionTarget.removeEventListener(eventName, this.#handleUserInteraction);
    }
    this.#interactionListenersAttached = false;
  }

  #updateSnapshot(patch: Partial<AudioEngineSnapshot>): void {
    const nextSnapshot: AudioEngineSnapshot = {
      ...this.#snapshot,
      ...patch,
    };
    if (
      nextSnapshot.isReady === this.#snapshot.isReady &&
      nextSnapshot.isMuted === this.#snapshot.isMuted &&
      nextSnapshot.masterGain === this.#snapshot.masterGain
    ) {
      return;
    }
    this.#snapshot = nextSnapshot;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
