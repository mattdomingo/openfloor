"use client";

import { useEffect, useRef } from "react";

// Ported from openfloor-ai/openfloor.ai's site.js waveField(): a handful of
// horizontal sine lines whose phase drifts over time, so they read as slow
// moving strands rather than a static pattern. Same tuning (9 lines, same
// amplitude/frequency/speed spread) and the same --entry-wave convention —
// an "r, g, b" custom property, since a canvas can't read a hex token, swapped
// per color scheme the same way the source site swaps --wave per theme.
export function WaveField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const lines = Array.from({ length: 9 }, (_, i) => ({
      y: (i + 0.5) / 9,
      travel: (i * 2.1) % (Math.PI * 2),
      speed: 0.0022 + (i % 4) * 0.0004,
      amplitude: 0.035 + (i % 3) * 0.02,
      frequency: 0.7 + (i % 5) * 0.22,
      phase: (i * 1.7) % (Math.PI * 2),
      phaseSpeed: 0.0004 + (i % 3) * 0.0002,
    }));

    const resize = () => {
      const r = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      if (!w || !h) return;
      canvas.width = w * r;
      canvas.height = h * r;
      ctx.setTransform(r, 0, 0, r, 0, 0);
    };

    const waveInk = () => `rgba(${getComputedStyle(canvas).getPropertyValue("--entry-wave").trim()}, 0.2)`;

    const draw = () => {
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = waveInk();
      for (const ln of lines) {
        ctx.beginPath();
        const segments = 96;
        for (let i = 0; i <= segments; i++) {
          const xFrac = i / segments;
          const y = (ln.y + ln.amplitude * Math.sin(xFrac * Math.PI * 2 * ln.frequency - ln.travel + ln.phase)) * h;
          if (i === 0) ctx.moveTo(0, y);
          else ctx.lineTo(xFrac * w, y);
        }
        ctx.stroke();
      }
    };

    resize();
    draw();
    const handleResize = () => { resize(); draw(); };
    window.addEventListener("resize", handleResize);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(handleResize) : null;
    ro?.observe(canvas);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return () => { window.removeEventListener("resize", handleResize); ro?.disconnect(); };
    }

    let raf = 0;
    let last: number | null = null;
    const step = (now: number) => {
      if (last == null) last = now;
      const dt = Math.min(now - last, 50) / 16.7;
      last = now;
      for (const ln of lines) {
        ln.travel += ln.speed * dt;
        ln.phase += ln.phaseSpeed * dt;
      }
      draw();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      ro?.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="entry-wave" aria-hidden="true" />;
}
