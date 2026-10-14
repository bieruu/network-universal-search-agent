"use client";

import dynamic from "next/dynamic";

const Ambient3DInner = dynamic(() => import("./Ambient3DInner"), { ssr: false });

export default Ambient3DInner;
export { Ambient3DInner };