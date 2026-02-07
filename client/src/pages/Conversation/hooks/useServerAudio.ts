import { useCallback, useEffect, useRef, useState } from "react";
import { useSocketContext } from "../SocketContext";
import { decodeMessage } from "../../../protocol/encoder";
import { useMediaContext } from "../MediaContext";
import { createDecoderWorker, initDecoder, getPrewarmedWorker } from "../../../decoder/decoderWorker";

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
      workletStats.current = event.data;
      actualAudioPlayed.current = workletStats.current.actualAudioPlayed;
      
      // Track when we've started playing audio
      if (workletStats.current.actualAudioPlayed > 0 && !hasStartedPlayingAudio.current) {
        hasStartedPlayingAudio.current = true;
        console.log(`[AUDIO-DEBUG] Audio playback started! actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s, totalPlayed=${workletStats.current.totalAudioPlayed.toFixed(3)}s`);
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
    
    const now = Date.now();
    const timeSinceLastAudio = lastAudioMessageTime.current ? now - lastAudioMessageTime.current : null;
    lastAudioMessageTime.current = now;
    
    // Detect BOS (Beginning of Stream) page - indicates a new Opus stream
    // This happens when a new audio response starts
    const isBOS = data.length >= 4 && 
      data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53 && // "OggS"
      data.length >= 27 && (data[5] & 0x02) !== 0; // BOS flag set
    
    // Also detect potential new response if there's a significant gap (>1000ms) in audio messages
    // This handles cases where the server doesn't send a BOS page for subsequent responses
    // A gap of >1 second typically indicates the previous response ended and a new one is starting
    const isLikelyNewResponse = hasStartedPlayingAudio.current && 
      timeSinceLastAudio !== null && 
      timeSinceLastAudio > 1000 && 
      !isBOS;
    
    if (isBOS) {
      console.log(`[AUDIO-DEBUG] BOS page detected: size=${data.length}, hasStartedPlaying=${hasStartedPlayingAudio.current}, actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s, totalPlayed=${workletStats.current.totalAudioPlayed.toFixed(3)}s, totalMessages=${totalAudioMessages.current}`);
    }
    
    if (isLikelyNewResponse) {
      console.log(`[AUDIO-DEBUG] ⚠️ LIKELY NEW RESPONSE (gap=${timeSinceLastAudio}ms) - Resetting worklet and decoder to prevent clutter`);
    }
    
    if ((isBOS && hasStartedPlayingAudio.current) || isLikelyNewResponse) {
      // New Opus stream detected after we've started playing audio - reset worklet AND decoder BEFORE decoding
      // This prevents distortion/clutter from carrying over between responses
      console.log(`[AUDIO-DEBUG] ⚠️ NEW OPUS STREAM AFTER FIRST RESPONSE - Resetting worklet and decoder to prevent clutter`);
      console.log(`[AUDIO-DEBUG]   Before reset: actualPlayed=${workletStats.current.actualAudioPlayed.toFixed(3)}s, totalPlayed=${workletStats.current.totalAudioPlayed.toFixed(3)}s, delay=${workletStats.current.delay.toFixed(3)}s`);
      
      // Reset worklet
      worklet.current.port.postMessage({type: "reset"});
      
      // Reset decoder worker by sending a reset command (if supported)
      // The decoder worker may have internal state (like resampler state) that needs clearing
      decoderWorker.current.postMessage({command: "reset"});
      console.log(`[AUDIO-DEBUG]   Decoder reset command sent (if supported, decoder will reset its internal state)`);
      
      // Note: If decoder doesn't support reset, it will ignore the command and continue.
      // This is usually fine as Opus decoders handle new streams via BOS pages.
      // However, if clutter persists, we may need to re-initialize the decoder worker.
      
      // Reset the flag so we don't reset on the very next BOS
      hasStartedPlayingAudio.current = false;
      receivedDuration.current = 0;
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
