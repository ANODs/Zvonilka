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

// Extend types for vendor prefixes
interface FsDocument extends Document {
  mozFullScreenElement?: Element;
  msFullscreenElement?: Element;
  webkitFullscreenElement?: Element;
  mozCancelFullScreen?: () => Promise<void>;
  msExitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void>;
}

interface FsHTMLElement extends HTMLElement {
  mozRequestFullScreen?: () => Promise<void>;
  msRequestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void>;
}

export const FullscreenButton: React.FC<FullscreenButtonProps> = ({ targetRef, className }) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSupported, setIsSupported] = useState(true);

  useEffect(() => {
    const doc = document as FsDocument;
    
    // Check if fullscreen is supported at all
    const fullscreenEnabled = document.fullscreenEnabled || 
                              (doc as any).webkitFullscreenEnabled || 
                              (doc as any).mozFullScreenEnabled ||
                              (doc as any).msFullscreenEnabled;
    
    setIsSupported(!!fullscreenEnabled);

    const handleFullscreenChange = () => {
      const fullscreenEl = document.fullscreenElement || 
                           doc.mozFullScreenElement || 
                           doc.webkitFullscreenElement || 
                           doc.msFullscreenElement;
      setIsFullscreen(!!fullscreenEl);
    };

    const events = [
      'fullscreenchange', 
      'webkitfullscreenchange', 
      'mozfullscreenchange', 
      'MSFullscreenChange'
    ];

    events.forEach(event => document.addEventListener(event, handleFullscreenChange));
    
    return () => {
      events.forEach(event => document.removeEventListener(event, handleFullscreenChange));
    };
  }, []);

  const toggleFullscreen = async () => {
    const doc = document as FsDocument;
    const element = (targetRef?.current || document.documentElement) as FsHTMLElement;

    try {
      const fullscreenEl = document.fullscreenElement || 
                           doc.mozFullScreenElement || 
                           doc.webkitFullscreenElement || 
                           doc.msFullscreenElement;

      if (!fullscreenEl) {
        // Enter fullscreen
        if (element.requestFullscreen) {
          await element.requestFullscreen();
        } else if (element.webkitRequestFullscreen) {
          await element.webkitRequestFullscreen();
        } else if (element.mozRequestFullScreen) {
          await element.mozRequestFullScreen();
        } else if (element.msRequestFullscreen) {
          await element.msRequestFullscreen();
        } else {
            // iOS Safari workaround for video elements specifically, 
            // but for generic divs it's not supported.
            // If the user really wants to "maximize" on iOS, we might need a CSS fallback,
            // but for now we just log it.
            console.warn("Fullscreen API is not supported on this device/browser.");
        }
      } else {
        // Exit fullscreen
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        } else if (doc.mozCancelFullScreen) {
          await doc.mozCancelFullScreen();
        } else if (doc.msExitFullscreen) {
          await doc.msExitFullscreen();
        }
      }
    } catch (err) {
      console.error("Error toggling fullscreen:", err);
    }
  };

  if (!isSupported) {
    // Optionally hide the button if not supported, 
    // but often it's better to keep it and maybe it works via polyfills or just fails gracefully.
    // For iOS we often want to hide it if we can't do anything.
    // But let's keep it visible for now as 'isSupported' check might be tricky on some devices.
    // Or we can return null to hide it.
    // return null; 
  }

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
