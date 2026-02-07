import { useCallback, useEffect, useState, useRef } from "react";
import { useSocketContext } from "../SocketContext";
import { decodeMessage } from "../../../protocol/encoder";

export const useServerText = () => {
  const [text, setText] = useState<string[]>([]);
  const [totalTextMessages, setTotalTextMessages] = useState(0);
  const { socket } = useSocketContext();
  
  // Batch text updates to reduce UI re-renders during streaming
  const pendingTextRef = useRef<string[]>([]);
  const textUpdateTimeoutRef = useRef<number | null>(null);
  const textUpdateThrottle = 200; // Update UI every 200ms instead of on every token

  const flushPendingText = useCallback(() => {
    if (pendingTextRef.current.length > 0) {
      setText(text => [...text, ...pendingTextRef.current]);
      setTotalTextMessages(count => count + pendingTextRef.current.length);
      pendingTextRef.current = [];
    }
    textUpdateTimeoutRef.current = null;
  }, []);

  const onSocketMessage = useCallback((e: MessageEvent) => {
    const dataArray = new Uint8Array(e.data);
    const message = decodeMessage(dataArray);
    if (message.type === "text") {
      // Batch text tokens instead of updating on every token
      pendingTextRef.current.push(message.data);
      
      // Schedule UI update (throttled)
      if (textUpdateTimeoutRef.current === null) {
        textUpdateTimeoutRef.current = window.setTimeout(flushPendingText, textUpdateThrottle);
      }
    }
  }, [flushPendingText]);

  useEffect(() => {
    const currentSocket = socket;
    if (!currentSocket) {
      return;
    }
    setText([]);
    pendingTextRef.current = [];
    if (textUpdateTimeoutRef.current !== null) {
      clearTimeout(textUpdateTimeoutRef.current);
      textUpdateTimeoutRef.current = null;
    }
    currentSocket.addEventListener("message", onSocketMessage);
    return () => {
      currentSocket.removeEventListener("message", onSocketMessage);
      // Flush any pending text on cleanup
      if (textUpdateTimeoutRef.current !== null) {
        clearTimeout(textUpdateTimeoutRef.current);
        flushPendingText();
      }
    };
  }, [socket, flushPendingText]);

  return { text, totalTextMessages };
};
