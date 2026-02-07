import { FC, useEffect, useRef } from "react";
import { useServerText } from "../../hooks/useServerText";

type TextDisplayProps = {
  containerRef: React.RefObject<HTMLDivElement>;
};

export const TextDisplay:FC<TextDisplayProps> = ({
  containerRef,
}) => {
  const { text } = useServerText();
  const currentIndex = text.length - 1;
  const prevScrollTop = useRef(0);

  // Throttle scrolling to reduce UI overhead
  const scrollTimeoutRef = useRef<number | null>(null);
  
  useEffect(() => {
    // Clear any pending scroll
    if (scrollTimeoutRef.current !== null) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    // Throttle scroll updates to reduce overhead
    scrollTimeoutRef.current = window.setTimeout(() => {
      if (containerRef.current) {
        prevScrollTop.current = containerRef.current.scrollTop;
        // Use 'auto' instead of 'smooth' for better performance
        containerRef.current.scroll({
          top: containerRef.current.scrollHeight,
          behavior: "auto", // Changed from "smooth" to "auto" for better performance
        });
      }
      scrollTimeoutRef.current = null;
    }, 300); // Throttle scroll updates to every 300ms
    
    return () => {
      if (scrollTimeoutRef.current !== null) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [text]);

  return (
    <div className="h-full w-full max-w-full max-h-full  p-2">
        {text.map((t, i) => (
          <span
            key={i}
            className={`${i === currentIndex ? "font-bold" : "font-normal"}`}
          >
            {t}
          </span>
        ))}
    </div>
  );
};
