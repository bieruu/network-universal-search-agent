import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // --font-landing-mono is set on the landing wrapper only; elsewhere falls back to defaults.
        mono: ["var(--font-landing-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        input: [
          "0px 2px 3px -1px rgba(0, 0, 0, 0.1)",
          "0px 1px 0px 0px rgba(25, 28, 33, 0.02)",
          "0px 0px 0px 1px rgba(25, 28, 33, 0.08)",
        ].join(", "),
      },
      animation: {
        ripple: "ripple 2s ease calc(var(--i, 0) * 0.2s) infinite",
        orbit: "orbit calc(var(--duration) * 1s) linear infinite",
      },
      keyframes: {
        ripple: {
          "0%, 100%": { transform: "translate(-50%, -50%) scale(1)" },
          "50%": { transform: "translate(-50%, -50%) scale(0.9)" },
        },
        orbit: {
          "0%": {
            transform: "rotate(0deg) translateY(calc(var(--radius) * 1px)) rotate(0deg)",
          },
          "100%": {
            transform: "rotate(360deg) translateY(calc(var(--radius) * 1px)) rotate(-360deg)",
          },
        },
      },
    },
  },
  plugins: [],
};
export default config;
