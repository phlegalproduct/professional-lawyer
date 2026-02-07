import { useState } from "react";

type ServerAudioStatsProps = {
  getAudioStats: React.MutableRefObject<
    () => {
      playedAudioDuration: number;
      missedAudioDuration: number;
      totalAudioMessages: number;
      delay: number;
      minPlaybackDelay: number;
      maxPlaybackDelay: number;
    }
  >;
};

export const ServerAudioStats = ({ getAudioStats }: ServerAudioStatsProps) => {
  // Disable real-time refresh to save performance - only show initial stats
  const [audioStats] = useState(getAudioStats.current());

  let convertMinSecs = (total_secs: number) => {
    // convert secs to the format mm:ss.cc
    let mins = (Math.floor(total_secs / 60)).toString();
    let secs = (Math.floor(total_secs) % 60).toString();
    let cents = (Math.floor(100 * (total_secs - Math.floor(total_secs)))).toString();
    if (secs.length < 2) {
      secs = "0" + secs;
    }
    if (cents.length < 2) {
      cents = "0" + cents;
    }
    return mins + ":" + secs + "." + cents;
  };

  // Removed auto-refresh interval to save performance during audio playback
  // Stats will only show initial values and won't update in real-time

  return (
    <div className="w-full rounded-lg text-zinc-500 p-2">
      <h2 className="text-md pb-2">Server Audio Stats</h2>
      <table>
        <tbody>
          <tr>
            <td className="text-md pr-2">Audio played: </td>
            <td>{convertMinSecs(audioStats.playedAudioDuration)}</td>
          </tr>
          <tr>
            <td className="text-md pr-2">Missed audio: </td>
            <td>{convertMinSecs(audioStats.missedAudioDuration)}</td>
          </tr>
          <tr>
            <td className="text-md pr-2">Latency: </td>
            <td>{audioStats.delay.toFixed(3)}</td>
          </tr>
          <tr>
            <td className="text-md pr-2">Min/Max buffer: </td>
            <td>{audioStats.minPlaybackDelay.toFixed(3)} / {audioStats.maxPlaybackDelay.toFixed(3)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};
