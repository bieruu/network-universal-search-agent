"use client";

import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import * as THREE from "three";
import { PHASE_SECONDS } from "@/lib/motion-phases";
import { rgbCss, tokenRgb } from "@/lib/ambient-colors";

const TAU = Math.PI * 2;

function Scene({ paused, color }: { paused: boolean; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    if (paused || !meshRef.current) return;
    // Delta-time based so one revolution is one revolution on a 60Hz laptop and
    // on a 144Hz one alike. `color` is a prop on purpose: it comes from the
    // design tokens, so a theme flip re-renders this material instead of
    // leaving a hardcoded emerald on the new background.
    const step = Math.min(delta, 0.1);
    meshRef.current.rotation.y += (TAU / PHASE_SECONDS.globe) * step;
    meshRef.current.rotation.x += (TAU / (PHASE_SECONDS.globe * 1.5)) * step;
  });
  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[0.9, 1]} />
      <meshBasicMaterial color={color} wireframe opacity={0.1} transparent depthWrite={false} />
    </mesh>
  );
}

export default function Ambient3DInner() {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [color, setColor] = useState(() => rgbCss(tokenRgb("--accent", [0, 0.9, 0.6])));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Re-read the accent on every theme flip — a literal hex cannot follow the
  // theme, which is the whole reason the colour arrives as a token.
  useEffect(() => {
    const obs = new MutationObserver(() => setColor(rgbCss(tokenRgb("--accent", [0, 0.9, 0.6]))));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  if (reduced) {
    return <div ref={containerRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />;
  }

  return (
    <div ref={containerRef} aria-hidden="true" className="pointer-events-none absolute inset-0">
      <Canvas gl={{ antialias: true, alpha: true }} camera={{ position: [0, 0, 3.2], fov: 58 }} dpr={[1, 1.5]}>
        <Scene paused={!visible} color={color} />
      </Canvas>
      <span className="sr-only">ambient decoration, not scan data</span>
    </div>
  );
}
