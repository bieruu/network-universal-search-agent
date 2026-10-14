"use client";

import dynamic from "next/dynamic";

// Ambient3DInner pulls in three / @react-three/fiber and must never run during
// SSR. Keep it behind next/dynamic so WebGL only ships to the browser.
const Ambient3DInner = dynamic(() => import("./Ambient3DInner"), { ssr: false });

export default Ambient3DInner;

export { Ambient3DInner };