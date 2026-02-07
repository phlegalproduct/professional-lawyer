import { FC, useRef, useEffect } from "react";
import { AudioStats, useServerAudio } from "../../hooks/useServerAudio";
import { ServerVisualizer } from "../AudioVisualizer/ServerVisualizer";
import { type ThemeType } from "../../hooks/useSystemTheme";

type ServerAudioProps = {
  setGetAudioStats: (getAudioStats: () => AudioStats) => void;
  theme: ThemeType;
  onUserRecordingStopRef?: React.MutableRefObject<(() => void) | null>; // Ref to callback
};
export const ServerAudio: FC<ServerAudioProps> = ({ setGetAudioStats, theme, onUserRecordingStopRef }) => {
  const { analyser, hasCriticalDelay, setHasCriticalDelay, registerUserRecordingStopCallback } = useServerAudio({
    setGetAudioStats,
  });
  
  // Register the callback ref with useServerAudio
  useEffect(() => {
    if (onUserRecordingStopRef && registerUserRecordingStopCallback) {
      registerUserRecordingStopCallback(onUserRecordingStopRef);
    }
  }, [onUserRecordingStopRef, registerUserRecordingStopCallback]);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <>
      {hasCriticalDelay && (
        <div className="fixed left-0 top-0 flex w-screen justify-between bg-red-500 p-2 text-center">
          <p>A connection issue has been detected, you've been reconnected</p>
          <button
            onClick={async () => {
              setHasCriticalDelay(false);
            }}
            className="bg-white p-1 text-black"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="server-audio h-4/6 aspect-square" ref={containerRef}>
        <ServerVisualizer analyser={analyser.current} parent={containerRef} theme={theme}/>
      </div>
    </>
  );
};
