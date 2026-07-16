// The WeRace wordmark, inlined so the story renderer can tint it to whatever
// reads best on the chosen background (all-black on a light footer, all-white
// on a dark one). The source SVG fills every path via a single `.cls-1` class,
// so a colour swap is a one-line substitution.
export const WERACE_LOGO_VIEWBOX = { w: 2500, h: 474.94 }

/** The wordmark as an SVG string, every path filled with `color`. */
export function weraceLogoSvg(color: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2500 474.94">' +
    `<defs><style>.cls-1{fill:${color};}</style></defs>` +
    '<g id="Layer_2" data-name="Layer 2"><g id="Layer_1-2" data-name="Layer 1">' +
    '<path class="cls-1" d="M1100.1,386.08V88.86h164.55q47.85,0,82.77,13.59t53.95,38.85q19.05,25.26,19.05,59.65t-19.05,59.23q-19,24.84-53.95,38t-82.77,13.16H1164.07l51.27-41.19V386.08ZM1215.34,281.2l-51.27-45.43h93.26q23.93,0,35.4-9.34T1304.21,201q0-16.12-11.48-25.47t-35.4-9.34h-93.26l51.27-45.43Zm89.35,104.88-84-108.28h122.07l85,108.28Z"/>' +
    '<path class="cls-1" d="M1426.76,386.08,1576.18,88.86h113.28l149.41,297.22H1719.73L1609.38,136.42h44.92L1544,386.08Zm88.87-51.8,29.29-72.18h157.23l29.3,72.18Z"/>' +
    '<path class="cls-1" d="M2029.3,392.87q-41,0-75.93-11.25t-60.54-32.06a147.58,147.58,0,0,1-39.8-49.25q-14.16-28.44-14.16-62.84T1853,174.63a147.78,147.78,0,0,1,39.8-49.25q25.64-20.8,60.54-32.06t75.93-11.25q50.29,0,89.11,15.28t64.21,44.16L2109.87,198a114.57,114.57,0,0,0-33.45-25.69q-18.32-9.12-41.26-9.12a99,99,0,0,0-32.71,5.09,70.34,70.34,0,0,0-25.15,14.86,68.23,68.23,0,0,0-16.36,23.57,83.77,83.77,0,0,0,0,61.56,68.14,68.14,0,0,0,16.36,23.57,70.34,70.34,0,0,0,25.15,14.86,99.26,99.26,0,0,0,32.71,5.09q23,0,41.26-9.13A114.36,114.36,0,0,0,2109.87,277l72.75,56.47q-25.39,28.44-64.21,43.94T2029.3,392.87Z"/>' +
    '<path class="cls-1" d="M2329.1,310.5H2500v75.58H2215.82V88.86h277.83v75.58H2329.1Zm-7.81-111.24h152.34v72.18H2321.29Z"/>' +
    '<path class="cls-1" d="M186.38,386.08,77,88.86H195.66L284,339.8H224.46L318.21,88.86h106l87.4,250.94H454.44L546.73,88.86H656.1L546.73,386.08H423.19L351.9,180.57h33.21l-75.2,205.51Z"/>' +
    '<path class="cls-1" d="M794.77,310.5h170.9v75.58H681.49V88.86H959.32v75.58H794.77ZM787,199.26H939.3v72.18H787Z"/>' +
    '<path class="cls-1" d="M1042.67,474.94H0V0H1042.67ZM47.55,427.38H995.12V47.55H47.55Z"/>' +
    '</g></g></svg>'
  )
}

/** A data URL for `weraceLogoSvg(color)`, ready to feed an `<img>` / Image(). */
export function weraceLogoDataUrl(color: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(weraceLogoSvg(color))}`
}

/** Load the wordmark (in `color`) as an HTMLImageElement, resolved once decoded.
 * Rejects if the browser can't decode it. */
export function loadWeraceLogo(color: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = weraceLogoDataUrl(color)
  })
}
