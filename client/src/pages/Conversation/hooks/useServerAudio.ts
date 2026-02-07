import { useCallback, useEffect, useRef, useState } from "react";
import { useSocketContext } from "../SocketContext";
import { decodeMessage } from "../../../protocol/encoder";
import { useMediaContext } from "../MediaContext";
import { createDecoderWorker, initDecoder, getPrewarmedWorker } from "../../../decoder/decoderWorker";

// Helper to create a warmup BOS page for decoder initialization
const createWarmupBosPage = (): Uint8Array => {
  const opusHead = new Uint8Array([
    0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
    0x01,       // Version 1
    0x01,       // 1 channel (mono)
    0x38, 0x01, // Pre-skip: 312 samples (little-endian)
    0xC0, 0x5D, 0x00, 0x00, // Sample rate: 24000 Hz (little-endian)
    0x00, 0x00, // Output gain: 0
    0x00,       // Channel mapping: 0 (mono/stereo)
  ]);
  
  const pageHeader = new Uint8Array([
    0x4F, 0x67, 0x67, 0x53, // "OggS" magic
    0x00,       // Version 0
    0x02,       // BOS flag (Beginning of Stream)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Granule position: 0
    0x01, 0x00, 0x00, 0x00, // Stream serial: 1
    0x00, 0x00, 0x00, 0x00, // Page sequence: 0
    0x00, 0x00, 0x00, 0x00, // CRC (will be invalid but decoder doesn't check)
    0x01,       // 1 segment
    0x13,       // Segment size: 19 bytes (OpusHead)
  ]);
  
  const bosPage = new Uint8Array(pageHeader.length + opusHead.length);
  bosPage.set(pageHeader, 0);
  bosPage.set(opusHead, pageHeader.length);
  return bosPage;
};

export type AudioStats = {
  playedAudioDuration: number;
  missedAudioDuration: number;
  totalAudioMessages: number;
  delay: number;
  minPlaybackDelay: number;
  maxPlaybackDelay: number;
};

type useServerAudioArgs = {
  setGetAudioStats?: (getAudioStats: () => AudioStats) => void;
};

type WorkletStats = {
  totalAudioPlayed: number;
  actualAudioPlayed: number;
  delay: number;
  minDelay: number;
  maxDelay: number;
};

export const useServerAudio = ({setGetAudioStats}: useServerAudioArgs) => {
  const { socket, socketStatus } = useSocketContext();
  const {startRecording, stopRecording, audioContext, worklet, micDuration, actualAudioPlayed } =
    useMediaContext();
  const analyser = useRef(audioContext.current.createAnalyser());
  worklet.current.connect(analyser.current);
  const startTime = useRef<number | null>(null);
  const decoderWorker = useRef<Worker | null>(null);
  const [decoderReady, setDecoderReady] = useState(false);
  const [hasCriticalDelay, setHasCriticalDelay] = useState(false);
  const totalAudioMessages = useRef(0);
  const receivedDuration = useRef(0);
  const hasStartedPlayingAudio = useRef(false); // Track if we've started playing audio
  const lastAudioMessageTime = useRef<number | null>(null); // Track when we last received audio
  const lastPlaybackTime = useRef<number | null>(null); // Track when audio was last playing
  const playbackStoppedTime = useRef<number | null>(null); // Track when playback stopped
  const lastTextMessageCount = useRef(0); // Track text message count to detect new responses
  const pendingReset = useRef(false); // Flag to indicate decoder reset is pending
  const workletStats = useRef<WorkletStats>({
    totalAudioPlayed: 0,
    actualAudioPlayed: 0,
    delay: 0,
    minDelay: 0,
    maxDelay: 0,});

  const onDecode = useCallback(
    async (data: Float32Array) => {
      const duration = data.length / audioContext.current.sampleRate;
      receivedDuration.current += duration;
      console.log(`[AUDIO-DEBUG] Decoded frame: length=${data.length}, duration=${duration.toFixed(3)}s, sampleRate=${audioContext.current.sampleRate}, totalReceived=${receivedDuration.current.toFixed(3)}s, actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s`);
      worklet.current.port.postMessage({frame: data, type: "audio", micDuration: micDuration.current});
    },
    [],
  );

  const onWorkletMessage = useCallback(
    (event: MessageEvent<WorkletStats>) => {
      const prevActualPlayed = workletStats.current.actualAudioPlayed;
      const now = Date.now();
      workletStats.current = event.data;
      actualAudioPlayed.current = workletStats.current.actualAudioPlayed;
      
      // Track when we've started playing audio
      if (workletStats.current.actualAudioPlayed > 0 && !hasStartedPlayingAudio.current) {
        hasStartedPlayingAudio.current = true;
        lastPlaybackTime.current = now;
        playbackStoppedTime.current = null;
        console.log(`[AUDIO-DEBUG] Audio playback started! actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s, totalPlayed=${workletStats.current.totalAudioPlayed.toFixed(3)}s`);
      }
      
      // Track playback activity - if actualAudioPlayed is increasing, audio is playing
      if (workletStats.current.actualAudioPlayed > prevActualPlayed) {
        lastPlaybackTime.current = now;
        playbackStoppedTime.current = null;
      } else if (hasStartedPlayingAudio.current && lastPlaybackTime.current && (now - lastPlaybackTime.current > 500)) {
        // Audio has stopped playing for >500ms
        if (!playbackStoppedTime.current) {
          playbackStoppedTime.current = now;
          console.log(`[AUDIO-DEBUG] ⚠️ Playback stopped detected (no progress for ${now - lastPlaybackTime.current}ms)`);
        }
      }
      
      // Log significant state changes
      if (workletStats.current.actualAudioPlayed > prevActualPlayed + 0.1) {
        console.log(`[AUDIO-DEBUG] Worklet stats update: actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s (+${(workletStats.current.actualAudioPlayed - prevActualPlayed).toFixed(3)}s), totalPlayed=${workletStats.current.totalAudioPlayed.toFixed(3)}s, delay=${workletStats.current.delay.toFixed(3)}s, minDelay=${workletStats.current.minDelay.toFixed(3)}s, maxDelay=${workletStats.current.maxDelay.toFixed(3)}s`);
      }
    },
    [],
  );
  worklet.current.port.onmessage = onWorkletMessage;

  const getAudioStats = useCallback(() => {
    return {
      playedAudioDuration: workletStats.current.actualAudioPlayed,
      delay: workletStats.current.delay,
      minPlaybackDelay: workletStats.current.minDelay,
      maxPlaybackDelay: workletStats.current.maxDelay,
      missedAudioDuration: workletStats.current.totalAudioPlayed - workletStats.current.actualAudioPlayed,
      totalAudioMessages: totalAudioMessages.current,
    };
  }, []);

  const onWorkerMessage = useCallback(
    (e: MessageEvent<any>) => {
      if (!e.data) {
        return;
      }
      onDecode(e.data[0]);
    },
    [onDecode],
  );

  let midx = 0;
  const decodeAudio = useCallback((data: Uint8Array) => {
    if (!decoderWorker.current) {
      console.warn("Decoder worker not ready, dropping audio packet");
      return;
    }
    
    // If decoder reset is pending, drop this packet to avoid decoding with stale state
    if (pendingReset.current) {
      console.log(`[AUDIO-DEBUG] Dropping audio packet during decoder reset`);
      return;
    }
    
    const now = Date.now();
    const timeSinceLastAudio = lastAudioMessageTime.current ? now - lastAudioMessageTime.current : null;
    lastAudioMessageTime.current = now;
    
    // Detect BOS (Beginning of Stream) page - indicates a new Opus stream
    // This happens when a new audio response starts
    const isBOS = data.length >= 4 && 
      data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53 && // "OggS"
      data.length >= 27 && (data[5] & 0x02) !== 0; // BOS flag set
    
    // Also detect potential new response if:
    // 1. There's a significant gap (>1000ms) in audio messages, OR
    // 2. Playback had stopped (>500ms) and new audio is arriving
    // This handles cases where the server doesn't send a BOS page for subsequent responses
    // 2 second gap detection for phone-call-like conversation flow (one side speaks at a time)
    const hasGapInMessages = hasStartedPlayingAudio.current && 
      timeSinceLastAudio !== null && 
      timeSinceLastAudio > 2000 && 
      !isBOS;
    
    const playbackHadStopped = playbackStoppedTime.current !== null && 
      (now - playbackStoppedTime.current > 1000); // Increased to 1 second for more reliable detection
    
    const isLikelyNewResponse = hasStartedPlayingAudio.current && 
      (hasGapInMessages || playbackHadStopped) && 
      !isBOS;
    
    if (isBOS) {
      console.log(`[AUDIO-DEBUG] BOS page detected: size=${data.length}, hasStartedPlaying=${hasStartedPlayingAudio.current}, actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s, totalPlayed=${workletStats.current.totalAudioPlayed.toFixed(3)}s, totalMessages=${totalAudioMessages.current}`);
    }
    
    if (isLikelyNewResponse) {
      const reason = hasGapInMessages ? `gap=${timeSinceLastAudio}ms` : `playback stopped ${now - (playbackStoppedTime.current || now)}ms ago`;
      console.log(`[AUDIO-DEBUG] ⚠️ LIKELY NEW RESPONSE (${reason}) - Resetting worklet and decoder to prevent clutter`);
    }
    
    if ((isBOS && hasStartedPlayingAudio.current) || isLikelyNewResponse) {
      // New Opus stream detected after we've started playing audio - reset worklet AND re-initialize decoder BEFORE decoding
      // This prevents distortion/clutter from carrying over between responses
      // The server uses a single continuous Opus stream, so we need to reset decoder state between responses
      console.log(`[AUDIO-DEBUG] ⚠️ NEW OPUS STREAM AFTER FIRST RESPONSE - Resetting worklet and re-initializing decoder to prevent clutter`);
      console.log(`[AUDIO-DEBUG]   Before reset: actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s, totalPlayed=${workletStats.current.totalAudioPlayed.toFixed(3)}s, delay=${workletStats.current.delay.toFixed(3)}s`);
      
      // Reset worklet
      worklet.current.port.postMessage({type: "reset"});
      
      // Re-initialize decoder worker to clear all internal state (resampler, buffers, etc.)
      // The decoder worker doesn't support a "reset" command, so we must re-init it
      const bufferLength = 960 * audioContext.current.sampleRate / 24000;
      decoderWorker.current.postMessage({
        command: "init",
        bufferLength: bufferLength,
        decoderSampleRate: 24000,
        outputBufferSampleRate: audioContext.current.sampleRate,
        resampleQuality: 3, // High quality resampling
      });
      console.log(`[AUDIO-DEBUG]   Decoder re-initialized with sampleRate=${audioContext.current.sampleRate}Hz, bufferLength=${bufferLength}`);
      
      // Send warmup BOS page after a short delay to trigger decoder's internal init
      setTimeout(() => {
        const bosPage = createWarmupBosPage();
        decoderWorker.current?.postMessage({
          command: "decode",
          pages: bosPage,
        });
        console.log(`[AUDIO-DEBUG]   Warmup BOS page sent to re-initialized decoder`);
      }, 50);
      
      // Reset the flags so we don't reset on the very next BOS
      hasStartedPlayingAudio.current = false;
      receivedDuration.current = 0;
      lastPlaybackTime.current = null;
      playbackStoppedTime.current = null;
      console.log(`[AUDIO-DEBUG]   Reset complete, hasStartedPlayingAudio set to false`);
    }
    
    if (midx < 5) {
      // Log first few packets with size info for debugging
      const hasOggS = data.length >= 4 && 
        data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
      console.log(Date.now() % 1000, "Got NETWORK message", 
        micDuration.current - workletStats.current.actualAudioPlayed, 
        midx++, 
        "size:", data.length, 
        "hasOggS:", hasOggS,
        "isBOS:", isBOS);
    }
    decoderWorker.current.postMessage(
      {
        command: "decode",
        pages: data,
      },
      [data.buffer],
    );
  }, []);

  const onSocketMessage = useCallback(
    (e: MessageEvent) => {
      const dataArray = new Uint8Array(e.data);
      const message = decodeMessage(dataArray);
      if (message.type === "audio") {
        decodeAudio(message.data);
        //For stats purposes for now
        totalAudioMessages.current++;
      }
      // Note: We do NOT reset on text messages because:
      // 1. Text messages arrive incrementally during a response (as tokens are generated)
      // 2. Resetting on every text message causes stuttering/cutting words
      // 3. We rely on audio-based detection (gaps, playback stops, BOS pages) instead
    },
    [decodeAudio],
  );

  useEffect(() => {
    const currentSocket = socket;
    if (!currentSocket || socketStatus !== "connected" || !decoderReady) {
      return;
    }
    console.log(`[AUDIO-DEBUG] Connection established - Initializing audio pipeline`);
    console.log(`[AUDIO-DEBUG]   AudioContext sampleRate: ${audioContext.current.sampleRate} Hz`);
    console.log(`[AUDIO-DEBUG]   Decoder ready: ${decoderReady}`);
    worklet.current.port.postMessage({type: "reset"});
    hasStartedPlayingAudio.current = false; // Reset flag on new connection
    receivedDuration.current = 0;
    totalAudioMessages.current = 0;
    lastAudioMessageTime.current = null; // Reset audio message timing
    lastPlaybackTime.current = null;
    playbackStoppedTime.current = null;
    pendingReset.current = false;
    lastTextMessageCount.current = 0;
    console.log(`[AUDIO-DEBUG]   Worklet reset sent, flags cleared`);
    console.log(Date.now() % 1000, "Should start in a bit - decoder ready:", decoderReady);
    startRecording();
    currentSocket.addEventListener("message", onSocketMessage);
    console.log(`[AUDIO-DEBUG]   Socket message listener attached, recording started`);
    return () => {
      console.log("Stop recording called in unknown function.")
      stopRecording();
      startTime.current = null;
      currentSocket.removeEventListener("message", onSocketMessage);
    };
  }, [socket, socketStatus, decoderReady]);

  useEffect(() => {
    if (setGetAudioStats) {
      setGetAudioStats(getAudioStats);
    }
  }, [setGetAudioStats, getAudioStats]);

  // Use prewarmed worker if available, otherwise create fresh one
  useEffect(() => {
    let mounted = true;
    let workerInstance: Worker | null = null;
    
    const setupWorker = async () => {
      // Try to get prewarmed worker (was started when user clicked Connect on homepage)
      const prewarmed = await getPrewarmedWorker();
      
      if (!mounted) return;
      
      if (prewarmed) {
        console.log("Using prewarmed decoder worker");
        workerInstance = prewarmed;
      } else {
        console.log("No prewarmed worker available, creating fresh one");
        workerInstance = createDecoderWorker();
      }
      
      decoderWorker.current = workerInstance;
      
      // Set up message handler
      workerInstance.onmessage = onWorkerMessage;
      
      if (prewarmed) {
        // Prewarmed worker is already initialized
        console.log(`[AUDIO-DEBUG] Prewarmed decoder worker ready, sampleRate: ${audioContext.current.sampleRate} Hz`);
        setDecoderReady(true);
      } else {
        // Initialize fresh worker and wait for it to be ready
        console.log(`[AUDIO-DEBUG] Initializing fresh decoder worker with sampleRate: ${audioContext.current.sampleRate} Hz`);
        await initDecoder(workerInstance, audioContext.current.sampleRate);
        if (mounted) {
          console.log(`[AUDIO-DEBUG] Fresh decoder worker initialized, sampleRate: ${audioContext.current.sampleRate} Hz`);
          setDecoderReady(true);
        }
      }
    };
    
    setupWorker();

    return () => {
      mounted = false;
      console.log("Terminating decoder worker");
      if (workerInstance) {
        workerInstance.terminate();
      }
      decoderWorker.current = null;
      setDecoderReady(false);
    };
  }, [onWorkerMessage]);

  return {
    decodeAudio,
    analyser,
    getAudioStats,
    hasCriticalDelay,
    setHasCriticalDelay,
  };
};
