import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(222 47% 6%)",
        panel: "hsl(222 30% 10%)",
        panel2: "hsl(222 26% 13%)",
        border: "hsl(222 20% 20%)",
        muted: "hsl(218 12% 60%)",
        fg: "hsl(210 30% 96%)",
        accent: "hsl(152 65% 45%)",
        accent2: "hsl(199 89% 55%)",
        warn: "hsl(38 92% 55%)",
        danger: "hsl(0 72% 58%)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
