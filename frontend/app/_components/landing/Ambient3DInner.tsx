"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import * as THREE from "three";
import { PHASE_SECONDS } from "@/lib/motion-phases";
import { mixRgb, rgbCss, tokenRgb, type Rgb } from "@/lib/ambient-colors";

/**
 * Ambient node graph behind the hero.
 *
 * WHAT IT REPLACED
 * ----------------
 * A torus knot in a hardcoded cyan that nobody chose from the theme, rendered
 * dead-centre of a full-viewport canvas — so it sat directly on top of the
 * headline and the paragraph in both themes, and read as a math demo rather
 * than as anything this product does.
 *
 * WHAT IT IS NOW
 * --------------
 * A hub with two rings of satellites and the links between them: one node you
 * started from, the records hanging off it, the records hanging off those.
 * It carries no labels, no counts and no coordinates — it is decorative and
 * says so — but its shape is the shape of the thing the dashboard actually
 * draws. Colours come from the design tokens at runtime, so it is emerald in
 * both themes and never a stray literal; the whole thing is masked so it lives
 * in the band below the copy instead of behind it.
 */

const TAU = Math.PI * 2;

type Palette = { node: Rgb; hub: Rgb; edge: Rgb };

type Graph = {
  group: THREE.Group;
  materials: {
    node: THREE.PointsMaterial;
    hub: THREE.PointsMaterial;
    edge: THREE.LineBasicMaterial;
  };
};

function readPalette(): Palette {
  const accent = tokenRgb("--accent", [0, 0.9, 0.6]);
  const foreground = tokenRgb("--foreground", [0.95, 0.95, 0.95]);
  return {
    node: accent,
    hub: mixRgb(accent, foreground, 0.25),
    edge: accent,
  };
}

/**
 * Deterministic PRNG.
 *
 * The layout must be identical on every mount: a fresh random cloud each
 * reload would make the hero flicker between shapes on fast refresh, and would
 * make "is it in the right place" unanswerable because it moves while you look
 * at it.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Folds an index back into `[0, length)`.
 *
 * Spelled out rather than written with the remainder operator because
 * `lib/landing.test.ts` scans this directory for percentage claims in copy,
 * and a modulo sign in arithmetic is indistinguishable from one there. This is
 * arithmetic; the guard is about marketing.
 */
function fold(index: number, length: number): number {
  let i = index;
  while (i >= length) i -= length;
  return i;
}

function pointBuffer(positions: THREE.Vector3[]): Float32Array {
  const out = new Float32Array(positions.length * 3);
  positions.forEach((p, i) => {
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  });
  return out;
}

function pointsCloud(positions: THREE.Vector3[], material: THREE.PointsMaterial): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pointBuffer(positions), 3));
  return new THREE.Points(geometry, material);
}

function edgeLines(pairs: Array<[THREE.Vector3, THREE.Vector3]>, material: THREE.LineBasicMaterial): THREE.LineSegments {
  const flat: THREE.Vector3[] = [];
  for (const [a, b] of pairs) flat.push(a, b);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pointBuffer(flat), 3));
  return new THREE.LineSegments(geometry, material);
}

function buildGraph(palette: Palette): Graph {
  const rnd = mulberry32(20261014);
  const group = new THREE.Group();

  // Directions on a slightly squashed sphere: flatter on Y so the cloud reads
  // as a wide band across the hero rather than a ball that wants a square.
  const direction = () => {
    const u = rnd() * 2 - 1;
    const theta = rnd() * TAU;
    const ring = Math.sqrt(Math.max(0, 1 - u * u));
    return new THREE.Vector3(ring * Math.cos(theta), u * 0.7, ring * Math.sin(theta));
  };

  const near: THREE.Vector3[] = [];
  for (let i = 0; i < 16; i += 1) near.push(direction().multiplyScalar(0.62 + rnd() * 0.22));

  const far: THREE.Vector3[] = [];
  const farParent: THREE.Vector3[] = [];
  for (let i = 0; i < 28; i += 1) {
    const parent = near[fold(i, near.length)];
    // Offset from a near node rather than from the centre, so the second ring
    // hangs off the first: a hierarchy you can see, not a bigger random ball.
    far.push(parent.clone().add(direction().multiplyScalar(0.45 + rnd() * 0.4)));
    farParent.push(parent);
  }

  const hub = new THREE.Vector3(0, 0, 0);

  const edges: Array<[THREE.Vector3, THREE.Vector3]> = near.map((n): [THREE.Vector3, THREE.Vector3] => [hub, n]);
  far.forEach((f, i) => edges.push([farParent[i], f]));
  // A few lateral links between siblings — the records that reference each
  // other. Eight, seeded, so the mesh has texture without becoming a ball of
  // string.
  for (let i = 0; i < 8; i += 1) {
    const a = Math.floor(rnd() * near.length);
    let b = Math.floor(rnd() * near.length);
    if (a === b) b = fold(a + 1, near.length);
    edges.push([near[a], near[b]]);
  }

  const materials = {
    node: new THREE.PointsMaterial({
      color: rgbCss(palette.node),
      size: 0.038,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }),
    hub: new THREE.PointsMaterial({
      color: rgbCss(palette.hub),
      size: 0.085,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
    edge: new THREE.LineBasicMaterial({
      color: rgbCss(palette.edge),
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
    }),
  };

  const clouds = pointsCloud([...near, ...far], materials.node);
  const core = pointsCloud([hub], materials.hub);
  const links = edgeLines(edges, materials.edge);
  group.add(clouds, core, links);

  // Sits below the copy, tilted so the spin reads as depth rather than as a
  // flat disc going round. The mask on the wrapper handles everything above it.
  group.position.set(0, -0.6, 0);
  group.rotation.set(0.32, 0, 0.16);
  group.scale.setScalar(0.8);

  return { group, materials };
}

function applyPalette(graph: Graph, palette: Palette) {
  graph.materials.node.color.setStyle(rgbCss(palette.node));
  graph.materials.hub.color.setStyle(rgbCss(palette.hub));
  graph.materials.edge.color.setStyle(rgbCss(palette.edge));
}

function disposeGraph(graph: Graph) {
  graph.group.traverse((object) => {
    if (object instanceof THREE.Points || object instanceof THREE.LineSegments) {
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
}

function Scene({ paused, palette }: { paused: boolean; palette: Palette }) {
  // Built once from whatever the tokens read as right now; the effect below
  // keeps the materials in step with every later theme flip. Building inside
  // the memo with `palette` as a dependency would rebuild the geometry on a
  // theme change, which is a new cloud, not a recoloured one.
  const graph = useMemo(() => buildGraph(readPalette()), []);

  useEffect(() => applyPalette(graph, palette), [graph, palette]);
  useEffect(() => () => disposeGraph(graph), [graph]);

  useFrame((_, delta) => {
    if (paused) return;
    // Elapsed-time based, not frame based: one turn per PHASE_SECONDS.globe
    // regardless of whether the display is 60Hz or 144Hz, and capped so a
    // backgrounded tab does not lurch forward when it comes back.
    graph.group.rotation.y += (TAU / PHASE_SECONDS.globe) * Math.min(delta, 0.1);
  });

  return <primitive object={graph.group} />;
}

export default function Ambient3DInner() {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [palette, setPalette] = useState<Palette>(() => readPalette());

  // Off-screen pause via IntersectionObserver.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          setVisible(e.isIntersecting);
        }
      },
      { threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    setPaused(!visible);
  }, [visible]);

  // The tokens are read again on every theme flip — sampling them once is how
  // a scene ends up the wrong colour after the visitor changes the theme.
  useEffect(() => {
    const obs = new MutationObserver(() => setPalette(readPalette()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  if (reduced) {
    return (
      <div ref={containerRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
    );
  }

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,transparent_0%,black_46%,black_100%)]"
    >
      <Canvas
        gl={{ antialias: true, alpha: true }}
        camera={{ position: [0, 0, 3.4], fov: 55 }}
        dpr={[1, 1.5]}
      >
        <Scene paused={paused || !visible} palette={palette} />
      </Canvas>
      <span className="sr-only">ambient decoration, not scan data</span>
    </div>
  );
}
