'use client';

import React, { useState, useEffect } from 'react';
import { Maximize, Minimize } from 'lucide-react';
import { cn } from "@/lib/utils";

interface FullscreenButtonProps {
  /** 
   * Ref to the element to toggle fullscreen for.
   * If not provided, toggles the entire document (<html>).
   */
  targetRef?: React.RefObject<HTMLElement | null>; 
  className?: string;
}

export const FullscreenButton: React.FC<FullscreenButtonProps> = ({ targetRef, className }) => {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        // Enter fullscreen
        const element = targetRef?.current || document.documentElement;
        if (element) {
            await element.requestFullscreen();
        }
      } else {
        // Exit fullscreen
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error("Error toggling fullscreen:", err);
    }
  };

  return (
    <button
      onClick={toggleFullscreen}
      className={cn(
        "p-2 rounded-full bg-black/40 text-white transition-all hover:bg-black/60",
        className
      )}
      title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
    >
      {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
    </button>
  );
};
