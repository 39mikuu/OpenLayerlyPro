/** WCAG relative luminance for an opaque OKLCH color rendered in sRGB. */
export function oklchLuminance(lightness: number, chroma: number, hue: number): number {
  const angle = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.max(0, Math.min(1, channel)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function huePrimaryContrast(hue: number): { light: number; dark: number } {
  if (!Number.isInteger(hue) || hue < 0 || hue > 359) {
    return { light: 0, dark: 0 };
  }
  const lightPrimary = oklchLuminance(0.46, 0.16, hue);
  const darkPrimary = oklchLuminance(0.7, 0.16, hue);
  return {
    light: Math.min(
      contrastRatio(lightPrimary, oklchLuminance(0.985, 0, 0)),
      contrastRatio(lightPrimary, 1),
    ),
    dark: Math.min(
      contrastRatio(darkPrimary, oklchLuminance(0.18, 0.04, hue)),
      contrastRatio(darkPrimary, oklchLuminance(0.205, 0, 0)),
    ),
  };
}
